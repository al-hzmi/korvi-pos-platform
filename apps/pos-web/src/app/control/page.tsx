import { ControlApp } from '../../components/control/control-app';

/**
 * Merchant control-centre home. The route is intentionally explicit so a
 * refresh, bookmark or browser-history restore returns to the same product
 * surface instead of reconstructing navigation from client state.
 */
export default function Control(): React.JSX.Element {
  return <ControlApp section="home" />;
}
