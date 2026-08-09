import { ControlApp } from '../../components/control/control-app';

/**
 * The control centre.
 *
 * A server component that mounts the client shell, exactly as the till does.
 * No data is fetched here: every read is authenticated by a cookie that
 * belongs to the browser, and fetching on the server would mean forwarding it
 * by hand or inventing a second way to authenticate.
 */
export default function Control(): React.JSX.Element {
  return <ControlApp />;
}
