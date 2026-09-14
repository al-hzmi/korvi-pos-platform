import { PlatformSupportNotes } from '../../../../components/platform/platform-support-notes';
import { PlatformTenant } from '../../../../components/platform/platform-tenant';

interface PlatformTenantPageProps {
  readonly params: Promise<{ readonly tenantId: string }>;
}

export default async function PlatformTenantPage({
  params,
}: PlatformTenantPageProps): Promise<React.JSX.Element> {
  const { tenantId } = await params;
  return (
    <>
      <PlatformTenant tenantId={tenantId} />
      <PlatformSupportNotes tenantId={tenantId} />
    </>
  );
}
