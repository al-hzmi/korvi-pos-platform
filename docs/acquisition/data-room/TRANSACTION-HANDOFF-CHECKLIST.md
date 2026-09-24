# Transaction / Ownership Handoff Checklist

This checklist is intentionally separate from engineering completion.

## First-party IP

- [ ] identify legal seller/assignor;
- [ ] identify legal buyer/assignee;
- [ ] execute source-code/IP assignment or agreed license;
- [ ] include Git history and documentation in scope;
- [ ] explicitly state treatment of Korvi brand/trademark assets;
- [ ] identify any pre-existing IP excluded from transfer;
- [ ] confirm contributor/contractor assignment records where applicable.

## Third-party software

- [ ] export exact dependency license inventory from final lockfiles;
- [ ] legal review of material third-party licenses;
- [ ] record any attribution/notice obligations;
- [ ] record provider SDK/service terms separately from source-code licenses.

## Repository / development control

- [ ] transfer or grant repository ownership/access as transaction requires;
- [ ] review collaborator access;
- [ ] activate branch protection/rulesets on buyer-selected release/default branches;
- [ ] establish PR/review policy;
- [ ] establish release tag/signing policy;
- [ ] preserve canonical source SHA and evidence references.

## Cloud / operations

- [ ] transfer or recreate production cloud accounts;
- [ ] transfer domains/DNS if included;
- [ ] transfer monitoring/alerting ownership;
- [ ] rotate all credentials after control transfer;
- [ ] transfer secret-manager ownership without exposing secret values in documents;
- [ ] bind named production on-call contacts;
- [ ] verify backup ownership/restore authority.

## ZATCA / signing authority

- [ ] determine whether merchant-specific ZATCA identities transfer at all;
- [ ] provision buyer/merchant production identities appropriately;
- [ ] transfer operational ownership of Key Vault/HSM only through approved provider controls;
- [ ] rotate credentials/keys where required;
- [ ] preserve non-exportability requirements;
- [ ] verify post-transfer signing/reporting and reconciliation.

## Commercial records

- [ ] customer/merchant contracts if any;
- [ ] revenue/receivables evidence if any;
- [ ] pilot/acceptance evidence if any;
- [ ] support obligations if any;
- [ ] warranties/representations agreed in transaction.

## Final acceptance

- [ ] buyer can build exact source release;
- [ ] buyer can deploy to its environment;
- [ ] buyer can migrate/restore DB safely;
- [ ] buyer can identify every required environment variable without receiving secrets in plaintext documentation;
- [ ] buyer understands all external gates;
- [ ] residual risks are explicitly accepted or remediated;
- [ ] transfer record references final source SHA and final evidence package.
