import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Libxml2ZatcaCanonicalizer } from '../apps/api/dist/zatca/libxml2-canonicalizer.js';

const outputDirectory = process.argv[2];
if (outputDirectory === undefined) {
  throw new Error('Usage: node scripts/zatca-39-c14n-crosscheck.mjs <output-directory>');
}

const invoiceNamespace = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const cacNamespace = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const cbcNamespace = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const extNamespace = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';

// Deliberately non-canonical namespace/attribute order. Native xmllint and the
// production WASM adapter must independently normalize this to identical bytes.
const businessXml = [
  `<Invoice xmlns:ext="${extNamespace}" xmlns:cbc="${cbcNamespace}" xmlns="${invoiceNamespace}" xmlns:cac="${cacNamespace}" z="last" a="first">`,
  '<cbc:ProfileID>reporting:1.0</cbc:ProfileID>',
  '<cbc:ID schemeID="KORVI" schemeAgencyID="ZATCA">C14N-39</cbc:ID>',
  '<cac:AdditionalDocumentReference><cbc:ID>KEEP</cbc:ID></cac:AdditionalDocumentReference>',
  '</Invoice>',
].join('');

const sealedShapeXml = businessXml.replace(
  '<cbc:ProfileID>',
  [
    '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><cbc:ID>EXCLUDED-EXT</cbc:ID></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>',
    '<cac:Signature><cbc:ID>EXCLUDED-SIGNATURE</cbc:ID></cac:Signature>',
    '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment></cac:Attachment></cac:AdditionalDocumentReference>',
    '<cbc:ProfileID>',
  ].join(''),
);

const canonicalizer = new Libxml2ZatcaCanonicalizer();
const businessCanonical = await canonicalizer.canonicalizeInvoiceReference(businessXml);
const sealedCanonical = await canonicalizer.canonicalizeInvoiceReference(sealedShapeXml);

if (!Buffer.from(businessCanonical).equals(Buffer.from(sealedCanonical))) {
  throw new Error('ZATCA exclusions changed the signed business byte sequence.');
}

const directory = resolve(outputDirectory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(resolve(directory, 'business-source.xml'), businessXml, { mode: 0o600 });
writeFileSync(resolve(directory, 'sealed-shape-source.xml'), sealedShapeXml, { mode: 0o600 });
writeFileSync(resolve(directory, 'wasm-c14n11.xml'), businessCanonical, { mode: 0o600 });
writeFileSync(
  resolve(directory, 'wasm-c14n11.sha256'),
  `${createHash('sha256').update(businessCanonical).digest('hex')}\n`,
  { mode: 0o600 },
);

console.log(`[zatca39] source-bytes=${Buffer.byteLength(businessXml, 'utf8')}`);
console.log(`[zatca39] canonical-bytes=${businessCanonical.length}`);
console.log(
  `[zatca39] canonical-sha256=${createHash('sha256').update(businessCanonical).digest('hex')}`,
);
console.log('[zatca39] excluded-material neutrality=PASS');
