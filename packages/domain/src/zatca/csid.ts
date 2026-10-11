import { ZatcaInvoiceError } from './phase2.js';
import type { ZatcaCsrSubject } from '../ports/zatca.js';

const VAT_NUMBER = /^3\d{13}3$/;
const EGS_SERIAL = /^1-[^|]+\|2-[^|]+\|3-[^|]+$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const INVOICE_TYPE = /^[01]{4}$/;

function required(label: string, value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (normalized === '') {
    throw new ZatcaInvoiceError(`${label} is required for a ZATCA CSR.`);
  }
  return normalized;
}

/**
 * Validate and normalize the CSR subject facts Korvi is allowed to pass to the
 * security-module adapter.
 *
 * No value is invented here. The caller must source taxpayer, branch and EGS
 * identity from authoritative merchant/device configuration. The private key is
 * deliberately absent: proof-of-possession belongs to `ZatcaSigningKeyPort`.
 */
export function zatcaCsrSubject(input: ZatcaCsrSubject): ZatcaCsrSubject {
  const commonName = required('CSR common name', input.commonName);
  const egsSerialNumber = required('EGS serial number', input.egsSerialNumber);
  const organizationIdentifier = input.organizationIdentifier.trim();
  const organizationalUnitName = required(
    'CSR organizational unit name',
    input.organizationalUnitName,
  );
  const organizationName = required('CSR organization name', input.organizationName);
  const countryCode = input.countryCode.trim().toUpperCase();
  const invoiceType = input.invoiceType.trim();
  const location = required('CSR location', input.location);
  const industry = required('CSR industry', input.industry);

  if (!EGS_SERIAL.test(egsSerialNumber)) {
    throw new ZatcaInvoiceError(
      'EGS serial number must use the ZATCA format 1-provider|2-model-or-version|3-serial-number.',
    );
  }
  if (!VAT_NUMBER.test(organizationIdentifier)) {
    throw new ZatcaInvoiceError(
      'CSR organization identifier must be a 15-digit VAT number beginning and ending in 3.',
    );
  }
  if (!COUNTRY_CODE.test(countryCode)) {
    throw new ZatcaInvoiceError('CSR country code must be ISO 3166 alpha-2.');
  }
  if (!INVOICE_TYPE.test(invoiceType) || invoiceType === '0000') {
    throw new ZatcaInvoiceError(
      'CSR invoice type must be four 0/1 digits mapped to T,S,C,Z and enable at least one type.',
    );
  }

  return {
    commonName,
    egsSerialNumber,
    organizationIdentifier,
    organizationalUnitName,
    organizationName,
    countryCode,
    invoiceType,
    location,
    industry,
  };
}
