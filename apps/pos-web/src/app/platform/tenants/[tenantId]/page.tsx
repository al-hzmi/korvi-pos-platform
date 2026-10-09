import { PlatformOperationalBootstrap } from '../../../../components/platform/platform-operational-bootstrap';
import { PlatformOwnerBootstrap } from '../../../../components/platform/platform-owner-bootstrap';
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
      <PlatformOwnerBootstrap tenantId={tenantId} />
      <PlatformOperationalBootstrap tenantId={tenantId} />
      <PlatformSupportNotes tenantId={tenantId} />
    </>
  );
}
