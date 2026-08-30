import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, label, before, after) {
  const source = readFileSync(path, 'utf8');
  if (source.includes(after)) return;
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`5C service permission anchor missing: ${label}`);
  if (source.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C service permission anchor is not unique: ${label}`);
  }
  writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
}

replaceOnce(
  'apps/api/src/purchasing/service.ts',
  'cost permission import',
  `import { PurchasingRequestError } from '@korvi/domain';`,
  `import { PurchasingRequestError, requirePrincipalPermission } from '@korvi/domain';`,
);

replaceOnce(
  'apps/api/src/purchasing/service.ts',
  'cost-bearing receipt service guard',
  `    async receive(principal, request) {\n      return attempt(() =>\n        recordPurchaseReceipt(\n          prisma,\n          { tenantId: principal.tenantId, userId: principal.userId },\n          request,\n          fingerprintPurchaseReceipt(request, principal.userId),\n        ),\n      );\n    },`,
  `    async receive(principal, request) {\n      // Defense in depth: the HTTP route enforces this too, but the service is\n      // an authority boundary in its own right. An internal caller must not be\n      // able to establish acquisition value merely by bypassing the route.\n      if (request.lines.some((line) => line.inventoryValueMinor !== undefined)) {\n        requirePrincipalPermission(principal, 'inventory.cost.manage');\n      }\n\n      return attempt(() =>\n        recordPurchaseReceipt(\n          prisma,\n          { tenantId: principal.tenantId, userId: principal.userId },\n          request,\n          fingerprintPurchaseReceipt(request, principal.userId),\n        ),\n      );\n    },`,
);

const testPath = 'apps/api/src/__tests__/purchasing-service.test.ts';
if (!existsSync(testPath)) {
  writeFileSync(
    testPath,
    `import { describe, expect, it } from 'vitest';\nimport { PermissionDeniedError } from '@korvi/domain';\nimport { createMerchantPurchasingService } from '../purchasing/service.js';\nimport type { AuthenticatedPrincipal, Permission, PurchaseReceiptRequest } from '@korvi/domain';\nimport type { PrismaClient } from '@korvi/database';\n\nconst TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';\nconst USER = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4001';\nconst SESSION = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4002';\nconst ORDER = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4003';\nconst LINE = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4004';\n\nfunction principal(permissions: readonly Permission[]): AuthenticatedPrincipal {\n  return {\n    tenantId: TENANT,\n    tenantSlug: 'tenant',\n    userId: USER,\n    sessionId: SESSION,\n    email: 'manager@example.test',\n    displayName: 'Manager',\n    roles: ['manager'],\n    permissions,\n    maxDiscountBasisPoints: 0n,\n    branchId: null,\n  };\n}\n\nfunction request(inventoryValueMinor?: string): PurchaseReceiptRequest {\n  return {\n    operationId: 'receipt-op',\n    purchaseOrderId: ORDER,\n    reference: null,\n    lines: [\n      {\n        purchaseOrderLineId: LINE,\n        acceptedQuantityScaled: '1000',\n        ...(inventoryValueMinor === undefined ? {} : { inventoryValueMinor }),\n      },\n    ],\n  };\n}\n\nfunction databaseThatMustNotBeTouched(): PrismaClient {\n  return new Proxy(\n    {},\n    {\n      get() {\n        throw new Error('database touched');\n      },\n    },\n  ) as PrismaClient;\n}\n\ndescribe('purchasing service costing authority', () => {\n  it('refuses acquisition value before touching persistence without inventory.cost.manage', async () => {\n    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });\n\n    await expect(service.receive(principal(['purchasing.receive']), request('4500'))).rejects.toEqual(\n      expect.objectContaining({\n        name: 'PermissionDeniedError',\n        permission: 'inventory.cost.manage',\n      } satisfies Partial<PermissionDeniedError>),\n    );\n  });\n\n  it('does not require costing authority when cost evidence is omitted', async () => {\n    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });\n    await expect(service.receive(principal(['purchasing.receive']), request())).rejects.toThrow(\n      'database touched',\n    );\n  });\n\n  it('allows a cost-bearing receipt to reach persistence when both authorities are present', async () => {\n    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });\n    await expect(\n      service.receive(\n        principal(['purchasing.receive', 'inventory.cost.manage']),\n        request('0'),\n      ),\n    ).rejects.toThrow('database touched');\n  });\n});\n`,
  );
}
