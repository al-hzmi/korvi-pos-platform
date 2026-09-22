# KORVI — IP, Licensing and Provenance Position

Status: **AR-6 DILIGENCE RECORD — technical repository facts, not legal advice**
Created: 2026-09-22

## 1. Repository facts

- Repository: `al-hzmi/korvi-pos-platform`.
- Root package is marked `"private": true`.
- At the canonical acquisition checkpoint reviewed on 2026-09-22, no root or
  nested `LICENSE`, `LICENCE`, `NOTICE` or `COPYING` file was detected.
- Source history and merged PR history are retained rather than rewritten.
- Historical unsigned commits are not rewritten merely to manufacture signing
  provenance.

Absence of a repository license file must **not** be translated into a claim
that third parties have broad usage rights, nor into a claim that all assignment
questions are automatically solved.

## 2. First-party provenance

For acquisition diligence, preserve:

- full git commit history and refs;
- merged PR history and review records;
- exact canonical release SHA;
- authorship metadata already present in git;
- governance/ADR history showing material architecture decisions;
- release/test artifacts tied to exact SHAs.

Do not squash or rewrite old history solely for cosmetic provenance.

## 3. Third-party dependencies

The machine dependency inventory is the committed `package-lock.json` plus
workspace `package.json` files. CI enforces exact dependency pins and runs the
repository audit/invariant gates.

Third-party packages retain their own licenses and notices regardless of Korvi's
first-party licensing position. Before an acquisition or external distribution,
generate a current dependency/license report from the exact canonical lockfile
and have legal/commercial review flag copyleft, source-distribution, notice,
patent or attribution obligations.

The existing supply-chain record is
`docs/governance/SUPPLY-CHAIN-REVALIDATION-2026-09-08.md`.

## 4. Transaction diligence that remains human/legal

The repository cannot prove by code alone:

- employment/contractor IP-assignment terms for every contributor;
- ownership of externally supplied brand assets, fonts, images or customer data;
- trademark/domain ownership;
- whether a buyer wants an assignment, exclusive license or corporate share deal;
- jurisdiction-specific warranties/indemnities.

Those items are acquisition legal diligence and remain open until supported by
contracts/records outside source control.

## 5. Release signing policy

Going forward, use signed release commits/tags where practical and where the
repository owner has configured signing authority. Do not rewrite historical
unsigned commits solely to make the history appear signed.

Installed Windows/Android artifacts use their separate controlled release
signing authorities. Non-release CI packages are evidence only and must not be
represented as production-signed customer distributions.

## 6. Branch governance

No repository Ruleset was present when checked during AR-6 preparation, and the
connected automation identity did not expose Administration capability to
configure branch protection. The operating policy is therefore:

- integrate canonical product changes by PR;
- never force-update the canonical branch;
- require exact-SHA CI/C0 evidence before release claims;
- repository owner should enable branch protection/rulesets for the canonical
  branch when Administration access is available.

This is a transparent control gap, not a reason to falsify configuration state.
