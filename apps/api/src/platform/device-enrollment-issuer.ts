import { createPrismaClient } from '@korvi/database';
import {
  enrollPlatformDevice,
  revokePlatformDevice,
  type DeviceEnrollmentMutationResult,
  type PlatformDeviceEnrollmentRequest,
  type PlatformDeviceRevocationRequest,
} from '@korvi/database/device-enrollment';
import type { PrismaClient } from '@korvi/database';
import type { PlatformActor } from './service.js';

export type PlatformDeviceEnrollmentInput = Omit<
  PlatformDeviceEnrollmentRequest,
  'tenantId' | 'controlPlaneActorRef'
>;
export type PlatformDeviceRevocationInput = Omit<
  PlatformDeviceRevocationRequest,
  'tenantId' | 'enrollmentId' | 'controlPlaneActorRef'
>;

export class PlatformDeviceEnrollmentUnavailableError extends Error {
  public override readonly name = 'PlatformDeviceEnrollmentUnavailableError';

  public constructor() {
    super('Platform device enrollment authority is not configured.');
  }
}

let prisma: PrismaClient | null = null;

function database(): PrismaClient {
  if (prisma !== null) return prisma;
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new PlatformDeviceEnrollmentUnavailableError();
  prisma = createPrismaClient(url);
  return prisma;
}

export async function issuePlatformDeviceEnrollment(
  actor: PlatformActor,
  tenantId: string,
  input: PlatformDeviceEnrollmentInput,
): Promise<DeviceEnrollmentMutationResult> {
  return enrollPlatformDevice(database(), {
    tenantId,
    ...input,
    controlPlaneActorRef: actor.controlPlaneActorRef,
  });
}

export async function issuePlatformDeviceRevocation(
  actor: PlatformActor,
  tenantId: string,
  enrollmentId: string,
  input: PlatformDeviceRevocationInput,
): Promise<DeviceEnrollmentMutationResult> {
  return revokePlatformDevice(database(), {
    tenantId,
    enrollmentId,
    ...input,
    controlPlaneActorRef: actor.controlPlaneActorRef,
  });
}
