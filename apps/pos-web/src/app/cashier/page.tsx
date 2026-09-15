import { PosApp } from '../../components/pos-app';

/**
 * Explicit till surface.
 *
 * Unlike the root merchant landing, this route never redirects a legitimate
 * manager/owner away merely because they also hold management permissions. The
 * server still decides whether the current session may open shifts, sell,
 * refund or perform any other cashier operation.
 */
export default function CashierPage(): React.JSX.Element {
  return <PosApp />;
}
