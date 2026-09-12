import fs from 'node:fs';

const workflowPath = '.github/workflows/zatca-39-azure-hsm-custody-proof.yml';
const workflow = fs.readFileSync(workflowPath, 'utf8');

const required = [
  ['manual live-proof dispatch', /workflow_dispatch:/],
  ['OIDC token permission', /id-token:\s*write/],
  ['Azure OIDC login', /uses:\s*azure\/login@/],
  ['management-plane vault proof', /az keyvault show[\s\S]*--name "\$AZURE_KEY_VAULT_NAME"/],
  ['Premium SKU assertion', /sku_name\s*!=\s*'premium'/],
  ['Azure Key Vault resource assertion', /microsoft\.keyvault\/vaults/],
  ['configured vault binding', /configuredVaultBinding/],
  ['configured key binding', /configuredKeyBinding/],
  ['EC-HSM assertion', /kty\s*!=\s*'EC-HSM'/],
  ['P-256K assertion', /curve\s*!=\s*'P-256K'/],
  ['explicit non-exportable assertion', /exportable\s+is\s+not\s+False/],
  ['private EC component refusal', /private_d_present/],
  ['sign and verify key operations', /\{'sign', 'verify'\}\.issubset/],
  ['version-pinned key assertion', /versionPinned/],
  ['remote ES256K sign', /az keyvault key sign[\s\S]*--algorithm ES256K/],
  ['remote ES256K verify', /az keyvault key verify[\s\S]*--algorithm ES256K/],
  ['independent public-key verification', /crypto\.verify\(/],
  ['private-material artifact scan', /BEGIN \(EC \|RSA \|\)PRIVATE KEY/],
  ['sanitized Premium vault artifact', /artifacts\/zatca-39-azure-hsm\/vault-metadata\.json/],
  ['sanitized key metadata artifact', /artifacts\/zatca-39-azure-hsm\/key-metadata\.json/],
  ['commit-bound proof message', /korvi-zatca-gate-39:\$\{GITHUB_SHA\}/],
];

const failures = required.filter(([, pattern]) => !pattern.test(workflow));

if (failures.length > 0) {
  for (const [description] of failures) {
    console.error(`[x] Gate 39 proof contract missing: ${description}`);
  }
  process.exit(1);
}

if (/echo\s+"key_id=\$KEY_ID"/.test(workflow)) {
  console.error('[x] Gate 39 proof must not publish the raw versioned Key Vault key id');
  process.exit(1);
}

console.log('[ok] Gate 39 Azure Key Vault Premium HSM proof contract is intact');
