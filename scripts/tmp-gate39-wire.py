from pathlib import Path

schema = Path('packages/database/prisma/schema.prisma')
text = schema.read_text()
relation_marker = '  zatcaCsidProvisioningAttempts ZatcaCsidProvisioningAttempt[]\n'
relation_addition = relation_marker + '  zatcaFatooraCredentials          ZatcaFatooraCredential[]\n'
if 'model ZatcaFatooraCredential {' not in text:
    if text.count(relation_marker) != 2:
        raise SystemExit(
            f'expected tenant/terminal relation marker twice, got {text.count(relation_marker)}'
        )
    text = text.replace(relation_marker, relation_addition)
    model = '''

/// AES-256-GCM ciphertext for the Fatoora Basic-Authentication credential.
/// Plaintext token/secret and encryption keys deliberately have no columns.
model ZatcaFatooraCredential {
  tenantId     String @db.Uuid
  terminalId   String @db.Uuid
  credentialId String
  keyId        String
  nonce        Bytes
  ciphertext   Bytes
  authTag      Bytes
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  terminal Terminal @relation(fields: [tenantId, terminalId], references: [tenantId, id], onDelete: NoAction)

  @@id([tenantId, terminalId, credentialId], map: "zatca_fatoora_credentials_pkey")
  @@unique([tenantId, credentialId], map: "zatca_fatoora_credentials_tenantId_credentialId_key")
  @@index([tenantId, terminalId], map: "zatca_fatoora_credentials_tenantId_terminalId_idx")
  @@map("zatca_fatoora_credentials")
}
'''
    text = text.rstrip() + model
    schema.write_text(text)

index = Path('packages/database/src/index.ts')
text = index.read_text()
export_marker = (
    "export { createZatcaCsidProvisioningRepository } "
    "from './zatca/csid-provisioning-repository.js';\n"
)
if 'createZatcaFatooraCredentialRepository' not in text:
    addition = export_marker + (
        "export { createZatcaFatooraCredentialRepository } "
        "from './zatca/fatoora-credential-repository.js';\n"
        "export type {\n"
        "  ZatcaFatooraCiphertextRecord,\n"
        "  ZatcaFatooraCredentialRepository,\n"
        "} from './zatca/fatoora-credential-repository.js';\n"
    )
    if text.count(export_marker) != 1:
        raise SystemExit('database export marker missing')
    index.write_text(text.replace(export_marker, addition))

workflow = Path('.github/workflows/zatca-39-csid-postgres-proof.yml')
text = workflow.read_text()
text = text.replace(
    'Apply all thirteen migrations as application role',
    'Apply all fourteen migrations as application role',
)
text = text.replace('if [ "$count" -ne 13 ]; then', 'if [ "$count" -ne 14 ]; then')
text = text.replace(
    'Expected exactly 13 migrations, got $count',
    'Expected exactly 14 migrations, got $count',
)
text = text.replace("test \"$ledger\" = '13|13'", "test \"$ledger\" = '14|14'")

proof_marker = '''          trigger_count="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_trigger WHERE tgrelid='zatca_csid_provisioning_attempts'::regclass AND tgname='zatca_csid_provisioning_transition_guard' AND NOT tgisinternal")"
          test "$trigger_count" = '1'
          printf 'rls=%s\\npolicy_count=%s\\nforbidden_secret_columns=%s\\ntransition_guard=%s\\n' "$rls" "$policies" "$forbidden" "$trigger_count" | tee -a "$PROOF_LOG"
'''
proof_replacement = '''          trigger_count="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_trigger WHERE tgrelid='zatca_csid_provisioning_attempts'::regclass AND tgname='zatca_csid_provisioning_transition_guard' AND NOT tgisinternal")"
          test "$trigger_count" = '1'
          vault_rls="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT relrowsecurity::text || '|' || relforcerowsecurity::text FROM pg_class WHERE oid='zatca_fatoora_credentials'::regclass")"
          test "$vault_rls" = 'true|true'
          vault_policies="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='zatca_fatoora_credentials' AND policyname='zatca_fatoora_credentials_isolation'")"
          test "$vault_policies" = '1'
          vault_forbidden="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='zatca_fatoora_credentials' AND lower(column_name) IN ('otp','secret','fatoorasecret','fatoorasecretplaintext','rawsecret','binarysecuritytoken')")"
          test "$vault_forbidden" = '0'
          vault_shape="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FILTER (WHERE column_name IN ('nonce','ciphertext','authTag','keyId'))::text || '|' || count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='zatca_fatoora_credentials')"
          test "$vault_shape" = '4|9'
          vault_guard="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_trigger WHERE tgrelid='zatca_fatoora_credentials'::regclass AND tgname='zatca_fatoora_credential_identity_guard' AND NOT tgisinternal")"
          test "$vault_guard" = '1'
          printf 'rls=%s\\npolicy_count=%s\\nforbidden_secret_columns=%s\\ntransition_guard=%s\\nvault_rls=%s\\nvault_policy_count=%s\\nvault_forbidden_plaintext_columns=%s\\nvault_shape=%s\\nvault_identity_guard=%s\\n' "$rls" "$policies" "$forbidden" "$trigger_count" "$vault_rls" "$vault_policies" "$vault_forbidden" "$vault_shape" "$vault_guard" | tee -a "$PROOF_LOG"
'''
if 'vault_rls=' not in text:
    if proof_marker not in text:
        raise SystemExit('PostgreSQL proof marker missing')
    text = text.replace(proof_marker, proof_replacement)
workflow.write_text(text)
