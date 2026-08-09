import { PosApp } from '../components/pos-app';

/**
 * The till.
 *
 * A server component whose only job is to mount the client shell. There is no
 * server-side data fetching here on purpose: every read this app makes is
 * authenticated by a cookie that belongs to the browser, and fetching on the
 * server would mean either forwarding that cookie by hand or inventing a
 * second way to authenticate. Neither is worth it for a screen that is
 * interactive from its first frame anyway.
 */
export default function Home(): React.JSX.Element {
  return <PosApp />;
}
