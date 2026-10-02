# Korvi Ownership, IP Provenance and Licensing Position

Status: **TECHNICAL DUE-DILIGENCE RECORD — TRANSACTION DOCUMENTS STILL REQUIRED**

## Repository facts

At the current canonical acquisition lineage:

- root `package.json` marks the workspace `"private": true`;
- no root `LICENSE`, `LICENCE`, `NOTICE` or `COPYING` file is present;
- Git history provides technical commit provenance and release history;
- Git history by itself does not prove employment/contract assignment, contributor authority or transaction chain-of-title.

Therefore the repository should be treated as proprietary/internal code for acquisition handoff, with **no repository-level open-source license grant asserted for Korvi's own code**.

## Buyer/seller transaction requirement

A buyer should receive an explicit transaction document that states what is assigned or licensed, including:

- source code and Git history;
- trademarks/brand assets if included;
- deployment/runbook documentation;
- domains/accounts/cloud resources if included;
- signing/update keys and operational credentials through a controlled transfer;
- rights to modify, deploy, sublicense or resell as agreed;
- treatment of pre-existing third-party components.

The repository is not a substitute for that legal instrument.

## Contributor provenance

Before final acquisition close, the seller/owner must confirm any contributors whose work is material and retain the applicable employment, contractor, assignment or contribution records outside the public repository.

Repository evidence may identify who authored commits, but it must not be represented as legal proof of IP assignment.

## Third-party software

Korvi uses third-party npm, Rust/Tauri, GitHub Actions and provider SDK/runtime dependencies. Their licenses remain their own.

Current supply-chain controls include:

- exact npm lockfile;
- package-manager pin;
- dependency version verification;
- `npm audit` in CI;
- immutable GitHub Action SHAs;
- supply-chain revalidation records.

A final buyer legal review should export and review the third-party license inventory from the exact release lockfiles before transaction close. AR-6 engineering handoff can be prepared without inventing a legal opinion about compatibility.

## Current licensing position

- Korvi first-party repository code: proprietary/internal; no root OSS license grant present.
- Third-party dependencies: governed by their respective upstream licenses.
- Acquisition transfer: requires explicit seller/buyer assignment or license terms outside the repository.
- Open issue: legal chain-of-title confirmation is a transaction diligence item, not a code gate.
