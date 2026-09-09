import { readFileSync, writeFileSync } from 'node:fs';

const responsePath = process.argv[2];
const proofPath = process.argv[3];

if (responsePath === undefined || proofPath === undefined) {
  throw new Error(
    'Usage: node scripts/zatca-38-official-validator-assert.mjs <response-json> <proof-output>',
  );
}

const expectedErrors = [
  'QR_CODE_ERROR/QRCODE_INVALID',
  'SIGNATURE_ERROR/NullPointerException',
  'SIGNATURE_ERROR/certificate',
].sort();
const expectedWarnings = ['BR_KSA_WARNING/BR-KSA-27', 'BR_KSA_WARNING/BR-KSA-60'].sort();

function fail(message) {
  throw new Error(`ZATCA Gate 38 official-validator boundary failed: ${message}`);
}

function normalizeFindings(value, field) {
  if (!Array.isArray(value)) {
    fail(`${field} is not an array`);
  }
  return value.map((finding, index) => {
    if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) {
      fail(`${field}[${index}] is not an object`);
    }
    const category = finding.category;
    const code = finding.code;
    if (typeof category !== 'string' || category.length === 0) {
      fail(`${field}[${index}].category is missing`);
    }
    if (typeof code !== 'string' || code.length === 0) {
      fail(`${field}[${index}].code is missing`);
    }
    return `${category}/${code}`;
  });
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(responsePath, 'utf8'));
} catch (error) {
  fail(`response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  fail('response root is not an object');
}
if (parsed.valid !== false) {
  fail(`expected unsigned Gate 38 payload to remain invalid until Gate 39 sealing; got valid=${String(parsed.valid)}`);
}

const actualErrors = normalizeFindings(parsed.errors, 'errors').sort();
const actualWarnings = normalizeFindings(parsed.warnings, 'warnings').sort();

if (JSON.stringify(actualErrors) !== JSON.stringify(expectedErrors)) {
  fail(`unexpected error set: ${JSON.stringify(actualErrors)}`);
}
if (JSON.stringify(actualWarnings) !== JSON.stringify(expectedWarnings)) {
  fail(`unexpected warning set: ${JSON.stringify(actualWarnings)}`);
}

const forbiddenGate38Finding = [...actualErrors, ...actualWarnings].find((finding) => {
  const normalized = finding.toUpperCase();
  return (
    normalized.includes('XSD') ||
    normalized.includes('SCHEMA') ||
    normalized.includes('EN16931') ||
    (normalized.includes('BR-KSA') && !expectedWarnings.includes(finding)) ||
    normalized.includes('BR-CO') ||
    normalized.includes('BR-S') ||
    normalized.includes('BR-Z') ||
    normalized.includes('BR-E') ||
    normalized.includes('BR-O')
  );
});
if (forbiddenGate38Finding !== undefined) {
  fail(`content/schema finding escaped the Gate 39 residual boundary: ${forbiddenGate38Finding}`);
}

const proof = [
  'authority=ZATCA public Developer Portal validator',
  'gate=38',
  'unsigned_gate39_residuals=EXACT_MATCH',
  `errors=${actualErrors.join(',')}`,
  `warnings=${actualWarnings.join(',')}`,
  'content_schema_findings=NONE',
  'gate39_required=true',
  '',
].join('\n');
writeFileSync(proofPath, proof, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(proof);
