# Release Provenance — Canonical Acquisition Candidate

## Buyer-evaluable source

Branch: `release/canonical-acquisition-v1`

Exact SHA:

`61dbb34dea08809756fd767b907b0e852b7e5978`

This is the single source release a buyer should evaluate.

## Provenance rule

Earlier RC, Product, Restaurant, Migration and Security branches are development lineage/history, not competing release truth.

The acquisition program intentionally consolidated verified capabilities into one canonical lineage without blindly merging every historical branch commit.

## Current repository governance facts

As verified during data-room preparation:

- repository visibility: public;
- GitHub default branch: `main`;
- current acquisition PR: #62;
- PR #62 head: `release/canonical-acquisition-v1`;
- PR #62 exact head SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`;
- PR #62 remains open and is not merged to `main`;
- exact source commit is GitHub verified/signed;
- repository metadata reports no repository-level license object.

These facts are transaction/governance context. They do not change runtime quality.

## Hosted evaluation lineage

Render staging API and Web are both configured to the canonical branch and both currently report LIVE deploys at the exact source SHA.

Auto Deploy is OFF, which helps prevent accidental movement of the frozen evaluation environment.

## Release freeze

The source SHA remains frozen.

Data-room documentation lives on `docs/acquisition-data-room-61dbb34` and must not be mistaken for a new runtime release.

Any future material code fix requires an explicit new candidate SHA and a new evidence cycle.
