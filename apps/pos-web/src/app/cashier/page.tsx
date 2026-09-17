import { WebPosApp } from '../../components/web-pos-app';

/**
 * Explicit till surface.
 *
 * Unlike the root merchant landing, this route never redirects a legitimate
 * manager/owner away merely because they also hold management permissions. The
 * server still decides whether the current session may open shifts, sell,
 * refund or perform any other cashier operation. Browser Control navigation is
 * injected by this web host; installed Cashier omits it entirely.
 */
export default function CashierPage(): React.JSX.Element {
  return <WebPosApp controlCentreHref="/control" />;
}
