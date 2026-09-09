import { DomainError } from '../errors.js';
import { bytesToBase64 } from './base64.js';
import { mulDivRound } from '../money/rounding.js';
import { BASIS_POINT_SCALE, VAT_STANDARD_BP } from '../tax/basis-points.js';
import type { InvoiceRecord, SaleLineRecord, SaleRecord } from '../ports/persistence.js';

const UBL_INVOICE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const UBL_CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const UBL_CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const UBL_EXT_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';

/** ZATCA's specified PIH seed for the first invoice in an EGS sequence. */
export const ZATCA_INITIAL_PREVIOUS_INVOICE_HASH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

export type ZatcaSellerIdScheme = 'CRN' | 'MOM' | 'MLS' | '700' | 'SAG' | 'OTH';

export interface ZatcaSellerFiscalProfile {
  readonly registrationName: string;
  readonly vatRegistrationNumber: string;
  readonly legalId: string;
  readonly legalIdScheme: ZatcaSellerIdScheme;
  readonly streetName: string;
  readonly buildingNumber: string;
  readonly citySubdivisionName: string;
  readonly cityName: string;
  readonly postalZone: string;
  readonly countryCode: 'SA';
}

/**
 * Inputs whose authority is outside the historical sale snapshot.
 *
 * ICV and PIH are EGS-sequence facts, not sale numbering. Keeping them explicit
 * prevents branch receipt sequence from accidentally becoming the regulatory
 * EGS counter. The fiscal profile is likewise supplied by the merchant's
 * immutable fiscal configuration and is checked against the invoice snapshot.
 */
export interface ZatcaSimplifiedInvoiceHashInput {
  readonly sale: SaleRecord;
  readonly invoice: InvoiceRecord;
  readonly seller: ZatcaSellerFiscalProfile;
  readonly invoiceCounterValue: string;
  readonly previousInvoiceHash: string;
}

export interface ZatcaSimplifiedInvoiceHashResult {
  /** Canonical XML 1.1 bytes represented as a UTF-8 JavaScript string. */
  readonly canonicalXml: string;
  /** SHA-256 over canonicalXml, Base64 encoded per BR-KSA-26. */
  readonly invoiceHash: string;
  /** The normalized timestamp to be reused verbatim by the Phase 2 QR. */
  readonly issuedAt: string;
}

export class ZatcaInvoiceError extends DomainError {
  public override readonly name = 'ZatcaInvoiceError';
}

interface NormalizedIssueTime {
  readonly date: string;
  readonly time: string;
  readonly timestamp: string;
}

interface LineProjection {
  readonly line: SaleLineRecord;
  readonly quantity: string;
  readonly unitCode: 'PCE' | 'KGM';
  readonly netMinor: bigint;
  readonly vatMinor: bigint;
  readonly totalMinor: bigint;
  readonly priceBaseMinor: bigint;
  readonly allowanceMinor: bigint;
}

/**
 * Render the unsigned ZATCA Phase 2 hash payload for a domestic simplified sale.
 *
 * This is deliberately not described as a customer-ready Phase 2 invoice:
 * Gate 39 still has to add UBLExtensions, the cryptographic stamp, cac:Signature
 * and the final QR. BR-KSA-26 removes those nodes before hashing. By emitting
 * the remaining document directly in Canonical XML 1.1 form, Gate 39 can insert
 * those excluded nodes without changing the bytes that this function hashes.
 *
 * The supported fiscal scope is intentionally fail-closed: domestic simplified
 * tax invoices whose lines are all Saudi standard-rated VAT. A zero rate alone
 * cannot distinguish Z, E and O, each of which has different ZATCA reason-code
 * requirements. Until that classification is persisted as historical sale
 * truth, issuing such an XML would be an invented tax fact and is refused.
 */
export function renderZatcaSimplifiedInvoiceHashPayload(
  input: ZatcaSimplifiedInvoiceHashInput,
): { readonly canonicalXml: string; readonly issuedAt: string } {
  assertInput(input);

  const issue = normalizeIssueTime(input.sale.issuedAt);
  const lines = input.sale.lines.map((line) => projectLine(input.sale, line));
  assertSaleArithmetic(input, lines);

  const taxNetMinor = lines.reduce((sum, line) => sum + line.netMinor, 0n);
  const taxVatMinor = lines.reduce((sum, line) => sum + line.vatMinor, 0n);
  const totalMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0n);

  const xml = [
    `<Invoice xmlns="${UBL_INVOICE_NS}" xmlns:cac="${UBL_CAC_NS}" xmlns:cbc="${UBL_CBC_NS}" xmlns:ext="${UBL_EXT_NS}">`,
    '<cbc:ProfileID>reporting:1.0</cbc:ProfileID>',
    element('cbc:ID', input.invoice.invoiceNumber),
    element('cbc:UUID', input.invoice.id),
    element('cbc:IssueDate', issue.date),
    element('cbc:IssueTime', issue.time),
    '<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>',
    '<cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>',
    '<cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>',
    '<cac:AdditionalDocumentReference>',
    '<cbc:ID>ICV</cbc:ID>',
    element('cbc:UUID', input.invoiceCounterValue),
    '</cac:AdditionalDocumentReference>',
    '<cac:AdditionalDocumentReference>',
    '<cbc:ID>PIH</cbc:ID>',
    '<cac:Attachment>',
    `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeText(input.previousInvoiceHash)}</cbc:EmbeddedDocumentBinaryObject>`,
    '</cac:Attachment>',
    '</cac:AdditionalDocumentReference>',
    renderSupplier(input.seller),
    '<cac:AccountingCustomerParty><cac:Party></cac:Party></cac:AccountingCustomerParty>',
    renderTaxTotalWithoutSubtotal(taxVatMinor),
    renderTaxTotalWithSubtotal(taxNetMinor, taxVatMinor),
    renderLegalMonetaryTotal(taxNetMinor, totalMinor),
    ...lines.map(renderLine),
    '</Invoice>',
  ].join('');

  return { canonicalXml: xml, issuedAt: issue.timestamp };
}

/** Hash exactly the bytes rendered by the canonical payload builder. */
export async function hashZatcaCanonicalInvoice(canonicalXml: string): Promise<string> {
  if (canonicalXml.length === 0) {
    throw new ZatcaInvoiceError('Cannot hash an empty ZATCA invoice payload.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new ZatcaInvoiceError('Web Crypto SHA-256 is unavailable in this runtime.');
  }
  const bytes = new TextEncoder().encode(canonicalXml);
  const digest = await subtle.digest('SHA-256', bytes);
  return bytesToBase64(new Uint8Array(digest));
}

export async function buildZatcaSimplifiedInvoiceHash(
  input: ZatcaSimplifiedInvoiceHashInput,
): Promise<ZatcaSimplifiedInvoiceHashResult> {
  const rendered = renderZatcaSimplifiedInvoiceHashPayload(input);
  return {
    canonicalXml: rendered.canonicalXml,
    invoiceHash: await hashZatcaCanonicalInvoice(rendered.canonicalXml),
    issuedAt: rendered.issuedAt,
  };
}

function assertInput(input: ZatcaSimplifiedInvoiceHashInput): void {
  const { sale, invoice, seller } = input;
  if (sale.status !== 'finalized') {
    throw new ZatcaInvoiceError('Only a finalized sale may become a ZATCA invoice.');
  }
  if (invoice.invoiceType !== 'simplified') {
    throw new ZatcaInvoiceError('This authority only renders simplified tax invoices.');
  }
  if (invoice.saleId !== sale.id) {
    throw new ZatcaInvoiceError('Invoice and sale identity do not match.');
  }
  if (sale.currency !== 'SAR' || invoice.currency !== 'SAR') {
    throw new ZatcaInvoiceError('ZATCA Phase 2 projection currently requires SAR sale currency.');
  }
  if (invoice.issuedAt !== sale.issuedAt) {
    throw new ZatcaInvoiceError('Invoice issue time diverges from the immutable sale issue time.');
  }
  if (invoice.sellerName !== seller.registrationName) {
    throw new ZatcaInvoiceError('Invoice seller name diverges from the fiscal profile.');
  }
  if (invoice.sellerVatNumber !== seller.vatRegistrationNumber) {
    throw new ZatcaInvoiceError('Invoice seller VAT number diverges from the fiscal profile.');
  }
  if (!UUID_PATTERN.test(invoice.id)) {
    throw new ZatcaInvoiceError('Invoice UUID must be a canonical UUID string.');
  }
  assertNonEmptyXml('invoice number', invoice.invoiceNumber);
  if (!/^\d+$/.test(input.invoiceCounterValue)) {
    throw new ZatcaInvoiceError('ZATCA invoice counter value must contain digits only.');
  }
  if (!isBase64(input.previousInvoiceHash)) {
    throw new ZatcaInvoiceError('Previous invoice hash must be non-empty Base64.');
  }
  assertSeller(seller);
}

function assertSeller(seller: ZatcaSellerFiscalProfile): void {
  assertNonEmptyXml('seller registration name', seller.registrationName);
  assertNonEmptyXml('seller street name', seller.streetName);
  assertNonEmptyXml('seller district', seller.citySubdivisionName);
  assertNonEmptyXml('seller city', seller.cityName);

  if (!/^3\d{13}3$/.test(seller.vatRegistrationNumber)) {
    throw new ZatcaInvoiceError('Seller VAT number must be 15 digits beginning and ending in 3.');
  }
  if (!/^[A-Za-z0-9]+$/.test(seller.legalId)) {
    throw new ZatcaInvoiceError('Seller legal identifier must be alphanumeric.');
  }
  if (!/^(CRN|MOM|MLS|700|SAG|OTH)$/.test(seller.legalIdScheme)) {
    throw new ZatcaInvoiceError('Unsupported seller legal identifier scheme.');
  }
  if (!/^\d{4}$/.test(seller.buildingNumber)) {
    throw new ZatcaInvoiceError('Seller building number must contain exactly four digits.');
  }
  if (!/^\d{5}$/.test(seller.postalZone)) {
    throw new ZatcaInvoiceError('Seller postal code must contain exactly five digits.');
  }
  if (seller.countryCode !== 'SA') {
    throw new ZatcaInvoiceError('This simplified invoice authority is restricted to Saudi sellers.');
  }
}

function projectLine(sale: SaleRecord, line: SaleLineRecord): LineProjection {
  if (line.vatBasisPoints !== VAT_STANDARD_BP) {
    throw new ZatcaInvoiceError(
      `Line ${String(line.lineNumber)} is not standard-rated VAT; tax category cannot be inferred from rate alone.`,
    );
  }
  if (line.productType === null) {
    throw new ZatcaInvoiceError(
      `Line ${String(line.lineNumber)} has no immutable product type; refusing to invent a UBL unit code.`,
    );
  }

  const quantityScaled = positiveInteger(line.quantityScaled, 'line quantity');
  const grossMinor = nonNegativeInteger(line.grossMinor, 'line gross');
  const netMinor = nonNegativeInteger(line.netMinor, 'line net');
  const vatMinor = nonNegativeInteger(line.vatMinor, 'line VAT');
  const totalMinor = nonNegativeInteger(line.totalMinor, 'line total');

  const priceBaseMinor =
    sale.priceMode === 'tax-exclusive'
      ? grossMinor
      : grossMinor -
        mulDivRound(grossMinor, line.vatBasisPoints, BASIS_POINT_SCALE + line.vatBasisPoints);
  const allowanceMinor = priceBaseMinor - netMinor;

  if (allowanceMinor < 0n) {
    throw new ZatcaInvoiceError(
      `Line ${String(line.lineNumber)} net exceeds its pre-discount tax-exclusive base.`,
    );
  }
  if (netMinor + vatMinor !== totalMinor) {
    throw new ZatcaInvoiceError(`Line ${String(line.lineNumber)} does not reconcile net + VAT = total.`);
  }

  assertNonEmptyXml('line item name', line.nameAr);
  return {
    line,
    quantity: scaledQuantity(quantityScaled),
    unitCode: line.productType === 'weighted' ? 'KGM' : 'PCE',
    netMinor,
    vatMinor,
    totalMinor,
    priceBaseMinor,
    allowanceMinor,
  };
}

function assertSaleArithmetic(
  input: ZatcaSimplifiedInvoiceHashInput,
  lines: readonly LineProjection[],
): void {
  if (lines.length === 0) {
    throw new ZatcaInvoiceError('A ZATCA invoice requires at least one sale line.');
  }

  const lineNet = lines.reduce((sum, line) => sum + line.netMinor, 0n);
  const lineVat = lines.reduce((sum, line) => sum + line.vatMinor, 0n);
  const lineTotal = lines.reduce((sum, line) => sum + line.totalMinor, 0n);
  const saleNet = nonNegativeInteger(input.sale.netMinor, 'sale net');
  const saleVat = nonNegativeInteger(input.sale.vatMinor, 'sale VAT');
  const saleTotal = nonNegativeInteger(input.sale.totalMinor, 'sale total');
  const invoiceNet = nonNegativeInteger(input.invoice.netMinor, 'invoice net');
  const invoiceVat = nonNegativeInteger(input.invoice.vatMinor, 'invoice VAT');
  const invoiceTotal = nonNegativeInteger(input.invoice.totalMinor, 'invoice total');

  if (lineNet !== saleNet || lineVat !== saleVat || lineTotal !== saleTotal) {
    throw new ZatcaInvoiceError('Historical sale lines do not reconcile to the sale totals.');
  }
  if (saleNet + saleVat !== saleTotal) {
    throw new ZatcaInvoiceError('Historical sale does not reconcile net + VAT = total.');
  }
  if (invoiceNet !== saleNet || invoiceVat !== saleVat || invoiceTotal !== saleTotal) {
    throw new ZatcaInvoiceError('Invoice snapshot diverges from the authoritative sale totals.');
  }
  if (input.invoice.taxBreakdown.length !== 1) {
    throw new ZatcaInvoiceError('Standard-rated scope requires exactly one VAT breakdown.');
  }
  const bucket = input.invoice.taxBreakdown[0];
  if (
    bucket === undefined ||
    bucket.vatBasisPoints !== VAT_STANDARD_BP ||
    nonNegativeInteger(bucket.netMinor, 'VAT bucket net') !== saleNet ||
    nonNegativeInteger(bucket.vatMinor, 'VAT bucket VAT') !== saleVat
  ) {
    throw new ZatcaInvoiceError('Invoice VAT breakdown diverges from the standard-rated sale truth.');
  }
}

function renderSupplier(seller: ZatcaSellerFiscalProfile): string {
  return [
    '<cac:AccountingSupplierParty><cac:Party>',
    `<cac:PartyIdentification><cbc:ID schemeID="${escapeAttribute(seller.legalIdScheme)}">${escapeText(seller.legalId)}</cbc:ID></cac:PartyIdentification>`,
    '<cac:PostalAddress>',
    element('cbc:StreetName', seller.streetName),
    element('cbc:BuildingNumber', seller.buildingNumber),
    element('cbc:CitySubdivisionName', seller.citySubdivisionName),
    element('cbc:CityName', seller.cityName),
    element('cbc:PostalZone', seller.postalZone),
    `<cac:Country><cbc:IdentificationCode>${seller.countryCode}</cbc:IdentificationCode></cac:Country>`,
    '</cac:PostalAddress>',
    '<cac:PartyTaxScheme>',
    element('cbc:CompanyID', seller.vatRegistrationNumber),
    '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
    '</cac:PartyTaxScheme>',
    `<cac:PartyLegalEntity>${element('cbc:RegistrationName', seller.registrationName)}</cac:PartyLegalEntity>`,
    '</cac:Party></cac:AccountingSupplierParty>',
  ].join('');
}

function renderTaxTotalWithoutSubtotal(vatMinor: bigint): string {
  return `<cac:TaxTotal>${moneyElement('cbc:TaxAmount', vatMinor)}</cac:TaxTotal>`;
}

function renderTaxTotalWithSubtotal(netMinor: bigint, vatMinor: bigint): string {
  return [
    '<cac:TaxTotal>',
    moneyElement('cbc:TaxAmount', vatMinor),
    '<cac:TaxSubtotal>',
    moneyElement('cbc:TaxableAmount', netMinor),
    moneyElement('cbc:TaxAmount', vatMinor),
    '<cac:TaxCategory>',
    '<cbc:ID>S</cbc:ID>',
    '<cbc:Percent>15.00</cbc:Percent>',
    '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
    '</cac:TaxCategory>',
    '</cac:TaxSubtotal>',
    '</cac:TaxTotal>',
  ].join('');
}

function renderLegalMonetaryTotal(netMinor: bigint, totalMinor: bigint): string {
  return [
    '<cac:LegalMonetaryTotal>',
    moneyElement('cbc:LineExtensionAmount', netMinor),
    moneyElement('cbc:TaxExclusiveAmount', netMinor),
    moneyElement('cbc:TaxInclusiveAmount', totalMinor),
    moneyElement('cbc:PayableAmount', totalMinor),
    '</cac:LegalMonetaryTotal>',
  ].join('');
}

function renderLine(projected: LineProjection): string {
  const { line } = projected;
  const allowance =
    projected.allowanceMinor === 0n
      ? ''
      : [
          '<cac:AllowanceCharge>',
          '<cbc:ChargeIndicator>false</cbc:ChargeIndicator>',
          '<cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>',
          '<cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>',
          moneyElement('cbc:Amount', projected.allowanceMinor),
          '</cac:AllowanceCharge>',
        ].join('');

  return [
    '<cac:InvoiceLine>',
    element('cbc:ID', String(line.lineNumber)),
    `<cbc:InvoicedQuantity unitCode="${projected.unitCode}">${projected.quantity}</cbc:InvoicedQuantity>`,
    moneyElement('cbc:LineExtensionAmount', projected.netMinor),
    allowance,
    '<cac:Item>',
    element('cbc:Name', line.nameAr),
    '<cac:ClassifiedTaxCategory>',
    '<cbc:ID>S</cbc:ID>',
    '<cbc:Percent>15.00</cbc:Percent>',
    '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
    '</cac:ClassifiedTaxCategory>',
    '</cac:Item>',
    '<cac:Price>',
    moneyElement('cbc:PriceAmount', projected.priceBaseMinor),
    `<cbc:BaseQuantity unitCode="${projected.unitCode}">${projected.quantity}</cbc:BaseQuantity>`,
    '</cac:Price>',
    '</cac:InvoiceLine>',
  ].join('');
}

function moneyElement(name: string, minor: bigint): string {
  return `<${name} currencyID="SAR">${minorToMajor(minor)}</${name}>`;
}

function element(name: string, value: string): string {
  assertXml10(value, name);
  return `<${name}>${escapeText(value)}</${name}>`;
}

function minorToMajor(minor: bigint): string {
  if (minor < 0n) throw new ZatcaInvoiceError('ZATCA invoice amounts must not be negative.');
  return `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function scaledQuantity(value: bigint): string {
  const whole = value / 1_000n;
  const fraction = value % 1_000n;
  return `${whole.toString()}.${fraction.toString().padStart(3, '0')}`;
}

function normalizeIssueTime(value: string): NormalizedIssueTime {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(value);
  if (match === null) {
    throw new ZatcaInvoiceError('Invoice issue time must be an explicit UTC ISO-8601 timestamp.');
  }
  const date = match[1];
  const clock = match[2];
  if (date === undefined || clock === undefined || Number.isNaN(Date.parse(`${date}T${clock}Z`))) {
    throw new ZatcaInvoiceError('Invoice issue time is not a real UTC date/time.');
  }
  const time = `${clock}Z`;
  return { date, time, timestamp: `${date}T${time}` };
}

function positiveInteger(value: string, field: string): bigint {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0n) throw new ZatcaInvoiceError(`${field} must be greater than zero.`);
  return parsed;
}

function nonNegativeInteger(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ZatcaInvoiceError(`${field} must be a non-negative integer string.`);
  }
  return BigInt(value);
}

function assertNonEmptyXml(field: string, value: string): void {
  if (value.trim().length === 0) throw new ZatcaInvoiceError(`${field} must not be empty.`);
  assertXml10(value, field);
}

function assertXml10(value: string, field: string): void {
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const valid =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) throw new ZatcaInvoiceError(`${field} contains a character XML 1.0 cannot represent.`);
    index += codePoint > 0xffff ? 2 : 1;
  }
}

function escapeText(value: string): string {
  assertXml10(value, 'XML text');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#xD;');
}

function escapeAttribute(value: string): string {
  assertXml10(value, 'XML attribute');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&#x9;')
    .replaceAll('\n', '&#xA;')
    .replaceAll('\r', '&#xD;');
}

function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
