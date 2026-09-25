import { MerchantEntry } from '../components/merchant-entry';

/**
 * Merchant entry point.
 *
 * Authentication still happens in the browser against the single merchant
 * session realm. Once the server has resolved the effective permission set,
 * the browser host may route management-capable users to Merchant Control
 * before any terminal or shift request starts. Cashier-only users continue
 * into the till flow. The explicit /cashier route remains available to an
 * authorised manager/owner who deliberately needs to operate a till.
 */
export default function Home(): React.JSX.Element {
  return <MerchantEntry />;
}
