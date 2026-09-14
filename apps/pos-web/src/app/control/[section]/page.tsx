import { ControlApp } from '../../../components/control/control-app';

interface ControlSectionPageProps {
  readonly params: Promise<{ readonly section: string }>;
}

export default async function ControlSectionPage({
  params,
}: ControlSectionPageProps): Promise<React.JSX.Element> {
  const { section } = await params;
  return <ControlApp requestedSection={section} />;
}
