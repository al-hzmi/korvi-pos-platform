#!/usr/bin/env bash
#
# Dependency advisory gate — FAIL CLOSED.
#
# The governing rule: only a valid, parsed, schema-checked audit result can
# produce a pass. Every other outcome fails.
#
# That includes the ones that look like successes: npm exiting non-zero for a
# network reason, an empty file, malformed JSON, or a report whose shape we do
# not recognise. A security gate that passes when it could not run is worse than
# no gate, because it reports safety it never established.

set -uo pipefail

ALLOWLIST_FILE="${AUDIT_ALLOWLIST:-scripts/audit-allowlist.txt}"
THRESHOLD="${AUDIT_LEVEL:-high}"
REGISTRY="${NPM_PUBLIC_REGISTRY:-https://registry.npmjs.org}"
REPORT="${AUDIT_REPORT:-$(mktemp)}"

echo "Auditing dependencies at level: $THRESHOLD (registry: $REGISTRY)"

# KORVI_AUDIT_SKIP_NPM lets the gate's own tests feed it a prepared report so
# the fail-closed paths can be exercised without a network. It only skips the
# npm call; every check below still runs exactly as it does in CI.
if [ "${KORVI_AUDIT_SKIP_NPM:-0}" = "1" ]; then
  NPM_EXIT=0
else
  # Deliberately no `|| true`. npm audit exits non-zero both when it finds
  # advisories and when it fails to run, so the exit code alone cannot be
  # trusted either way -- the JSON is inspected below and decides.
  npm audit --registry="$REGISTRY" --audit-level="$THRESHOLD" --json > "$REPORT" 2>/dev/null
  NPM_EXIT=$?
fi

if [ ! -s "$REPORT" ]; then
  printf '\033[1;31m[x]\033[0m audit produced no output (npm exit %s).\n' "$NPM_EXIT" >&2
  echo "    Treating an unavailable audit as a failure: this gate cannot" >&2
  echo "    certify what it was unable to check." >&2
  exit 1
fi

node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";

const [reportPath, threshold, allowlistFile, npmExit] = process.argv.slice(1);
const ORDER = ["info", "low", "moderate", "high", "critical"];

const fail = (reason) => {
  console.error(`\n[x] ${reason}`);
  console.error("    Fail-closed: only a valid audit result can pass this gate.");
  process.exit(1);
};

if (ORDER.indexOf(threshold) < 0) fail(`Unknown audit level "${threshold}".`);

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  fail(`Audit output is not valid JSON (${error.message}).`);
}

// Schema check. npm has changed this shape between majors, and silently
// reading an unexpected structure as "no vulnerabilities" is the exact
// false-pass this gate exists to prevent.
if (report === null || typeof report !== "object") fail("Audit output is not an object.");
if (Object.hasOwn(report, "error")) {
  fail(`npm audit reported an error: ${JSON.stringify(report.error)}`);
}
if (!Object.hasOwn(report, "vulnerabilities") || typeof report.vulnerabilities !== "object") {
  fail(
    "Audit output has no `vulnerabilities` object — unrecognised schema " +
      `(npm exit ${npmExit}). Refusing to interpret it.`,
  );
}
if (!Object.hasOwn(report, "metadata")) {
  fail("Audit output has no `metadata` — unrecognised schema. Refusing to interpret it.");
}
if (
  report.metadata === null ||
  typeof report.metadata !== "object" ||
  report.metadata.vulnerabilities === null ||
  typeof report.metadata.vulnerabilities !== "object"
) {
  fail("Audit metadata has no valid `vulnerabilities` severity counts.");
}

// Reviewed exceptions: "GHSA-id  justification | owner | expires YYYY-MM-DD".
const allowed = new Map();
const malformed = [];
if (existsSync(allowlistFile)) {
  for (const [index, raw] of readFileSync(allowlistFile, "utf8").split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^(GHSA-[\w-]+)\s+(.+?)\s*\|\s*([^|]+?)\s*\|\s*expires\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    const id = match?.[1] ?? "";
    const justification = match?.[2]?.trim() ?? "";
    const owner = match?.[3]?.trim() ?? "";
    const expiry = match?.[4];

    if (
      !/^GHSA-[\w-]+$/.test(id) ||
      justification === "" ||
      owner === "" ||
      expiry === undefined
    ) {
      malformed.push(`line ${index + 1}: ${line}`);
      continue;
    }
    allowed.set(id, { line, expiry, justification, owner });
  }
}

if (malformed.length > 0) {
  console.error("\nMalformed allowlist entries — every field is mandatory:");
  for (const entry of malformed) console.error(`  ${entry}`);
  fail("Allowlist entries must be: GHSA-id  justification | owner | expires YYYY-MM-DD");
}

const today = new Date().toISOString().slice(0, 10);
const minimum = ORDER.indexOf(threshold);
const blocking = [];
const excepted = [];
const expired = [];
let qualifyingPackages = 0;

for (const advisory of Object.values(report.vulnerabilities)) {
  if (advisory === null || typeof advisory !== "object") {
    fail("A vulnerability entry is not an object — unrecognised audit schema.");
  }
  if (ORDER.indexOf(advisory.severity) < minimum) continue;
  qualifyingPackages += 1;

  const vias = Array.isArray(advisory.via) ? advisory.via : [];
  if (vias.length === 0) {
    blocking.push(`${advisory.severity}  ${advisory.name ?? "(unknown package)"}  (no resolvable advisory)`);
    continue;
  }

  for (const via of vias) {
    // npm may represent an inherited vulnerability as the name of another
    // package rather than an advisory object. That is not enough information
    // to match a reviewed GHSA exception, so the gate must fail closed.
    if (typeof via === "string") {
      blocking.push(
        `${advisory.severity}  ${advisory.name ?? "(unknown package)"}  ` +
          `(unresolved via dependency: ${via})`,
      );
      continue;
    }
    if (via === null || typeof via !== "object") {
      blocking.push(
        `${advisory.severity}  ${advisory.name ?? "(unknown package)"}  (unrecognised via entry)`,
      );
      continue;
    }

    const id = (via.url ?? "").split("/").pop() ?? "";
    const label = `${via.severity ?? advisory.severity}  ${advisory.name ?? "(unknown package)"}  ${id || "(no id)"}`;
    const entry = allowed.get(id);

    // An advisory with no resolvable id can never be matched to a reviewed
    // exception, so it blocks. Unknown means blocked.
    if (entry === undefined) {
      blocking.push(`${label}\n        ${via.title ?? ""}`);
    } else if (entry.expiry < today) {
      expired.push(`${label} — exception expired ${entry.expiry}`);
    } else {
      excepted.push(`${label} — ${entry.line}`);
    }
  }
}

const metadataCounts = report.metadata.vulnerabilities;
let metadataAtThreshold = 0;
for (let index = minimum; index < ORDER.length; index += 1) {
  const severity = ORDER[index];
  const count = metadataCounts[severity] ?? 0;
  if (!Number.isInteger(count) || count < 0) {
    fail(`Audit metadata count for ${severity} is invalid.`);
  }
  metadataAtThreshold += count;
}
if (metadataAtThreshold > 0 && qualifyingPackages === 0) {
  fail(
    `Audit metadata reports ${metadataAtThreshold} vulnerability/vulnerabilities at or above ` +
      `${threshold}, but no qualifying vulnerability entries could be resolved.`,
  );
}

if (excepted.length > 0) {
  console.log("\nReviewed exceptions (still valid):");
  for (const line of [...new Set(excepted)]) console.log(`  ${line}`);
}
if (expired.length > 0) {
  console.error("\nEXPIRED exceptions — re-review or fix:");
  for (const line of [...new Set(expired)]) console.error(`  ${line}`);
}
const unique = [...new Set(blocking)];
if (unique.length > 0) {
  console.error("\nUnreviewed advisories:");
  for (const line of unique) console.error(`  ${line}`);
}

const failures = unique.length + expired.length;
if (failures > 0) {
  console.error(`\n[x] ${failures} advisory/advisories need attention.`);
  console.error(`    Fix them, or add a reviewed exception to ${allowlistFile}`);
  console.error("    as: GHSA-id  justification | owner | expires YYYY-MM-DD");
  process.exit(1);
}

console.log(`\n[ok] audit result valid; no unreviewed advisories at or above ${threshold}`);
' "$REPORT" "$THRESHOLD" "$ALLOWLIST_FILE" "$NPM_EXIT"
