import { notFound } from 'next/navigation';
import { ControlApp } from '../../../components/control/control-app';
import { controlSectionFromSlug } from '../../../lib/control-routes';

interface ControlSectionPageProps {
  readonly params: Promise<{ readonly section: string }>;
}

/**
 * Deep-link merchant workspace route. Invalid slugs are a real 404; valid
 * sections keep authentication, tenant, branch and permission authority in the
 * existing client/session boundary.
 */
export default async function ControlSectionPage({
  params,
}: ControlSectionPageProps): Promise<React.JSX.Element> {
  const { section: slug } = await params;
  const section = controlSectionFromSlug(slug);
  if (section === null || section === 'home') notFound();
  return <ControlApp section={section} />;
}
