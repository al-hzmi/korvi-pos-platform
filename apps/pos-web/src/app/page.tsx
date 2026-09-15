import { PosApp } from '../components/pos-app';

/**
 * Merchant entry point.
 *
 * Authentication still happens in the browser against the single merchant
 * session realm. Once the server has resolved the effective permission set,
 * management-capable users are sent to Merchant Control before any terminal or
 * shift request starts; cashier-only users continue into the till flow. The
 * explicit /cashier route remains available to an authorised manager/owner who
 * deliberately needs to operate a till.
 */
export default function Home(): React.JSX.Element {
  return <PosApp redirectManagementOnAuth />;
}
