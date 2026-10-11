# Korvi Dependency and Supply-Chain Handoff

Status: **ENGINEERING INVENTORY READY**

## Toolchain authority

- Node.js: `>=24.0.0 <25.0.0`
- npm package manager: `npm@11.19.0`
- npm lockfile: lockfileVersion 3
- monorepo workspaces: `packages/*`, `apps/*`

The exact versions in `package-lock.json` are release authority. CI uses `npm ci`; it does not fall back to `npm install`.

## Release supply-chain controls

- dependency pins verified by `scripts/verify-versions.mjs`;
- dependency advisories checked by `scripts/audit.sh`;
- GitHub Actions pinned to immutable commit SHAs;
- temporary dependency-refresh workflows are mechanically forbidden from surviving into release trees;
- production migration/runtime authority contract is mechanically checked;
- ZATCA HSM and Gate 50 proof contracts are mechanically checked;
- source tree invariant scanner rejects several classes of credential leakage and authority drift.

## Current notable platform dependencies

The lockfile is the complete machine-readable dependency inventory. Major runtime categories include:

- Fastify API;
- Prisma/PostgreSQL persistence;
- Next.js + React merchant/cashier web;
- Tauri installed cashier clients;
- Zod validation;
- libxml2 WASM/native canonicalization support;
- Vitest/TypeScript/ESLint/Prettier build and test toolchain.

This document intentionally does not duplicate every transitive package/version from the lockfile.

## Supply-chain status

The canonical CI must remain green on the final buyer-evaluable SHA. A dependency refresh receives no product-readiness credit by itself and must pass the same CI/PostgreSQL/browser gates required by the changed surface.

Latest historical revalidation record is `docs/governance/SUPPLY-CHAIN-REVALIDATION-2026-09-08.md`.

## Acquisition diligence item

Third-party license export/review is required before legal transaction close. The repository currently has no generated third-party license report that should be mistaken for a completed legal review.
