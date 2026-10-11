import {
  ZATCA_SIGNED_PROPERTIES_ID,
  ZATCA_XADES_NAMESPACE,
  ZatcaInvoiceError,
  type ZatcaXmlCanonicalizationPort,
} from '@korvi/domain';
import { ParseOption, XmlC14NMode, XmlDocument, XmlElement } from 'libxml2-wasm';

const UBL_INVOICE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const UBL_CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const UBL_CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const UBL_EXT_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const XMLDSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

const NAMESPACES = {
  inv: UBL_INVOICE_NS,
  cac: UBL_CAC_NS,
  cbc: UBL_CBC_NS,
  ext: UBL_EXT_NS,
  ds: XMLDSIG_NS,
  xades: ZATCA_XADES_NAMESPACE,
} as const;

const SECURE_PARSE_OPTIONS =
  ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_SYS_CATALOG;

const INVOICE_EXCLUSION_XPATH =
  "//ext:UBLExtensions | //cac:Signature | //cac:AdditionalDocumentReference[cbc:ID='QR']";
const TEXT_ENCODER = new TextEncoder();

/**
 * Production Canonical XML 1.1 adapter for ZATCA signing.
 *
 * libxml2 owns XML parsing and C14N semantics. The adapter deliberately does not
 * implement canonicalization with string manipulation. Invoice-reference XPath
 * transforms remove exactly the three ZATCA-excluded subtrees from a private
 * parsed copy and canonicalize the remaining document using C14N 1.1 without
 * comments. The caller's XML string is never mutated.
 */
export class Libxml2ZatcaCanonicalizer implements ZatcaXmlCanonicalizationPort {
  async canonicalizeInvoiceReference(xml: string): Promise<Uint8Array> {
    const document = parseFiscalXml(xml);
    try {
      assertInvoiceRoot(document);
      const excluded = document.find(INVOICE_EXCLUSION_XPATH, NAMESPACES);
      for (const node of excluded) {
        node.remove();
      }
      return canonicalDocumentBytes(document);
    } catch (error) {
      throw normalizeCanonicalizationError(error, 'invoice reference');
    } finally {
      document.dispose();
    }
  }

  async canonicalizeSignedProperties(xml: string): Promise<Uint8Array> {
    const document = parseFiscalXml(xml);
    try {
      assertInvoiceRoot(document);
      const allTargets = document.find(
        `//xades:SignedProperties[@Id='${ZATCA_SIGNED_PROPERTIES_ID}']`,
        NAMESPACES,
      );
      const signatureTargets = document.find(
        `//ds:Signature/ds:Object/xades:QualifyingProperties/xades:SignedProperties[@Id='${ZATCA_SIGNED_PROPERTIES_ID}']`,
        NAMESPACES,
      );
      const target = uniqueStructuredTarget(allTargets, signatureTargets, 'xades:SignedProperties');
      return canonicalNodeBytes(target);
    } catch (error) {
      throw normalizeCanonicalizationError(error, 'SignedProperties');
    } finally {
      document.dispose();
    }
  }

  async canonicalizeSignedInfo(xml: string): Promise<Uint8Array> {
    const document = parseFiscalXml(xml);
    try {
      assertInvoiceRoot(document);
      const allTargets = document.find('//ds:SignedInfo', NAMESPACES);
      const signatureTargets = document.find('//ds:Signature/ds:SignedInfo', NAMESPACES);
      const target = uniqueStructuredTarget(allTargets, signatureTargets, 'ds:SignedInfo');
      return canonicalNodeBytes(target);
    } catch (error) {
      throw normalizeCanonicalizationError(error, 'SignedInfo');
    } finally {
      document.dispose();
    }
  }
}

function parseFiscalXml(xml: string): XmlDocument {
  if (xml.length === 0) {
    throw new ZatcaInvoiceError('ZATCA canonicalization refuses an empty XML document.');
  }

  let document: XmlDocument;
  try {
    document = XmlDocument.fromString(xml, { option: SECURE_PARSE_OPTIONS });
  } catch {
    throw new ZatcaInvoiceError('ZATCA canonicalization requires well-formed UTF-8 XML.');
  }

  if (document.dtd !== null) {
    document.dispose();
    throw new ZatcaInvoiceError('ZATCA canonicalization refuses XML documents containing a DTD.');
  }
  if (document.warnings.length > 0) {
    document.dispose();
    throw new ZatcaInvoiceError('ZATCA canonicalization refuses XML parser warnings.');
  }
  return document;
}

function assertInvoiceRoot(document: XmlDocument): void {
  const roots = document.find('/inv:Invoice', NAMESPACES);
  if (roots.length !== 1) {
    throw new ZatcaInvoiceError('ZATCA canonicalization requires exactly one UBL Invoice root.');
  }
}

function uniqueStructuredTarget(
  allTargets: readonly unknown[],
  structuredTargets: readonly unknown[],
  label: string,
): XmlElement {
  if (allTargets.length !== 1 || structuredTargets.length !== 1) {
    throw new ZatcaInvoiceError(
      `ZATCA canonicalization requires one unambiguous ${label} in the expected signature structure.`,
    );
  }
  const target = allTargets[0];
  const structured = structuredTargets[0];
  if (
    !(target instanceof XmlElement) ||
    !(structured instanceof XmlElement) ||
    !target.isSameNode(structured)
  ) {
    throw new ZatcaInvoiceError(
      `ZATCA canonicalization found ${label} outside the expected signature structure.`,
    );
  }
  return target;
}

function canonicalDocumentBytes(document: XmlDocument): Uint8Array {
  return TEXT_ENCODER.encode(
    document.canonicalizeToString({
      mode: XmlC14NMode.XML_C14N_1_1,
      withComments: false,
    }),
  );
}

function canonicalNodeBytes(node: XmlElement): Uint8Array {
  return TEXT_ENCODER.encode(
    node.canonicalizeToString({
      mode: XmlC14NMode.XML_C14N_1_1,
      withComments: false,
    }),
  );
}

function normalizeCanonicalizationError(error: unknown, label: string): ZatcaInvoiceError {
  if (error instanceof ZatcaInvoiceError) {
    return error;
  }
  return new ZatcaInvoiceError(`ZATCA ${label} Canonical XML 1.1 processing failed closed.`);
}
