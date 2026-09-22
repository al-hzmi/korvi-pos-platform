# KORVI — Merchant Onboarding and Migration Guide

Status: **AR-6 OPERATOR GUIDE — AR-7 real merchant evidence still required**
Created: 2026-09-22

## 1. Supported onboarding chain

Normal onboarding must use product authorities, not direct SQL:

1. Platform Admin authenticates in the Platform realm.
2. Create tenant/business.
3. Assign plan/entitlements.
4. Bootstrap initial owner through the bounded one-time capability path.
5. Create/activate the first branch.
6. Register terminal/device.
7. Present tenant/login facts without exposing persistent secrets.
8. Merchant owner signs in.
9. Complete merchant settings/onboarding readiness.
10. Import supported legacy data if required.
11. Enroll/configure cashier device.
12. Open shift and execute controlled validation workflows.

## 2. Migration baseline

The verified Migration Engine baseline covers supported CSV/XLSX flows for:

- categories;
- products and product/category mapping;
- customers;
- suppliers;
- opening inventory.

M6 additionally supports explicit Customer `update-existing-by-phone`.
Other domains retain their verified conflict policies; do not infer generic
upsert/merge semantics.

Pipeline:

```text
UPLOAD
 -> FILE INSPECTION
 -> PARSE
 -> NORMALIZE
 -> FIELD MAPPING
 -> VALIDATION
 -> PREVIEW
 -> ERROR/WARNING REVIEW
 -> DRY RUN
 -> EXPLICIT COMMIT
 -> ROW RESULTS
 -> AUDIT / PROVENANCE
```

Never use file upload as a direct database write path.

## 3. Authority rules

- tenant identity is authenticated/server-derived;
- source files cannot provide internal tenant/customer/product/category UUID
  authority;
- committed imports use existing domain writers;
- retries remain idempotent;
- row-level errors are retained without leaking another tenant's state;
- opening inventory uses causal `migration-opening-stock` semantics;
- opening cost remains UNKNOWN unless explicit authoritative value semantics
  exist;
- opening customer/accounting balances are not invented without a defined
  ledger/accounting model.

## 4. Pre-commit operator checklist

- confirm file belongs to the merchant;
- retain an untouched source copy outside Korvi for business reconciliation;
- inspect mapping suggestions and resolve ambiguous columns manually;
- confirm dry-run row counts/errors/warnings;
- resolve missing categories/business keys before commit;
- choose conflict strategy explicitly where offered;
- confirm target branch/SKU business keys for opening inventory;
- do not import formulas/macros as executable authority.

## 5. Post-commit verification

After each migration domain:

- review created/updated/rejected counts;
- export/store the safe error report when rows failed;
- inspect representative records through Korvi UI/API, not raw SQL only;
- reconcile opening inventory totals to the source;
- verify audit/provenance and retry behavior;
- do not delete source reconciliation records until merchant acceptance.

## 6. Controlled pilot checklist

AR-7 must use a real merchant and record actual evidence for:

- onboarding/import;
- branch/terminal provisioning;
- operator sign-in and shift lifecycle;
- cash/electronic/mixed tender as applicable;
- return/refund;
- stock effects;
- receipts;
- Restaurant/quick-service flow if applicable;
- offline/reconnect behavior;
- backup/restore readiness;
- incident/rollback readiness;
- production ZATCA where legally/applicably activated.

Synthetic/staging results may rehearse this sequence but cannot close AR-7.
