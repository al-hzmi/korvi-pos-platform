import { ControlApp } from '../../../components/control/control-app';

interface ControlSectionPageProps {
  readonly params: Promise<{ readonly section: string }>;
}

/** A bookmarkable merchant control-centre surface backed by the authenticated shell. */
export default async function ControlSectionPage({
  params,
}: ControlSectionPageProps): Promise<React.JSX.Element> {
  const { section } = await params;
  return <ControlApp requestedSection={section} />;
}
