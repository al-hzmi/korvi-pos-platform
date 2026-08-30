import { readFileSync, writeFileSync } from 'node:fs';

function transform(path, work) {
  const before = readFileSync(path, 'utf8');
  const after = work(before);
  if (after !== before) writeFileSync(path, after);
}

function replaceOnce(text, label, before, after) {
  const first = text.indexOf(before);
  if (first === -1) throw new Error(`5C receiving anchor missing: ${label}`);
  if (text.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C receiving anchor is not unique: ${label}`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

transform('packages/domain/src/costing/costing.ts', (source) => {
  if (source.includes('POSTGRES_BIGINT_MAX')) return source;
  let next = replaceOnce(
    source,
    'postgres bigint maximum',
    `const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\\d*)$/;\n`,
    `const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\\d*)$/;\nconst POSTGRES_BIGINT_MAX = (1n << 63n) - 1n;\n`,
  );
  next = replaceOnce(
    next,
    'minor parser bigint bound',
    `  return BigInt(value);\n}\n`,
    `  const parsed = BigInt(value);\n  if (parsed > POSTGRES_BIGINT_MAX) {\n    throw new CostingRequestError(\n      'invalid-money',\n      \`\${field} exceeds PostgreSQL BIGINT storage.\`,\n    );\n  }\n  return parsed;\n}\n`,
  );
  return next;
});

transform('packages/domain/src/costing/__tests__/costing.test.ts', (source) => {
  if (source.includes('refuses values beyond PostgreSQL BIGINT')) return source;
  return replaceOnce(
    source,
    'costing request-boundary test',
    `  it('accepts exact non-negative minor-unit text and rejects float-like input', () => {\n    expect(parseNonNegativeMinor('0', 'value')).toBe(0n);\n    expect(parseNonNegativeMinor('9007199254740993', 'value')).toBe(9007199254740993n);\n    for (const bad of ['-1', '01', '1.0', '1e3', '+1', '', ' 1', '1 ', 'NaN']) {\n      expect(\n        refusalOf(() => parseNonNegativeMinor(bad, 'value')),\n        bad,\n      ).toBe('invalid-money');\n    }\n  });\n`,
    `  it('accepts exact non-negative minor-unit text and rejects float-like input', () => {\n    expect(parseNonNegativeMinor('0', 'value')).toBe(0n);\n    expect(parseNonNegativeMinor('9007199254740993', 'value')).toBe(9007199254740993n);\n    for (const bad of ['-1', '01', '1.0', '1e3', '+1', '', ' 1', '1 ', 'NaN']) {\n      expect(\n        refusalOf(() => parseNonNegativeMinor(bad, 'value')),\n        bad,\n      ).toBe('invalid-money');\n    }\n  });\n\n  it('accepts the PostgreSQL BIGINT maximum and refuses values beyond PostgreSQL BIGINT', () => {\n    expect(parseNonNegativeMinor('9223372036854775807', 'value')).toBe(9_223_372_036_854_775_807n);\n    expect(refusalOf(() => parseNonNegativeMinor('9223372036854775808', 'value'))).toBe(\n      'invalid-money',\n    );\n  });\n`,
  );
});

transform('packages/domain/src/purchasing/purchasing.ts', (source) => {
  if (source.includes('inventoryValueMinor?: string | undefined')) return source;
  let next = replaceOnce(
    source,
    'costing import',
    `import { DomainError } from '../errors.js';\n`,
    `import { CostingRequestError, parseNonNegativeMinor } from '../costing/costing.js';\nimport { DomainError } from '../errors.js';\n`,
  );
  next = replaceOnce(
    next,
    'invalid money refusal vocabulary',
    `  | 'invalid-reference';\n`,
    `  | 'invalid-reference'\n  | 'invalid-money';\n`,
  );
  next = replaceOnce(
    next,
    'costing refusal translation',
    `    if (error instanceof StockRequestError) {\n      const detail: PurchasingRequestRefusal =\n        error.detail === 'invalid-uuid' ? 'invalid-uuid' : 'invalid-quantity';\n      throw new PurchasingRequestError(detail, error.message);\n    }\n    throw error;\n`,
    `    if (error instanceof StockRequestError) {\n      const detail: PurchasingRequestRefusal =\n        error.detail === 'invalid-uuid' ? 'invalid-uuid' : 'invalid-quantity';\n      throw new PurchasingRequestError(detail, error.message);\n    }\n    if (error instanceof CostingRequestError) {\n      throw new PurchasingRequestError('invalid-money', error.message);\n    }\n    throw error;\n`,
  );
  next = replaceOnce(
    next,
    'receipt request acquisition value',
    `  /** Strictly positive. What physically arrived and was accepted. */\n  readonly acceptedQuantityScaled: string;\n}\n`,
    `  /** Strictly positive. What physically arrived and was accepted. */\n  readonly acceptedQuantityScaled: string;\n  /**\n   * Optional exact total inventory value for the accepted quantity, in minor\n   * units. This is acquisition-value evidence, never a unit price, tax amount\n   * or retail selling price. Omission means explicit unknown cost.\n   */\n  readonly inventoryValueMinor?: string | undefined;\n}\n`,
  );
  next = replaceOnce(
    next,
    'validated receipt acquisition value',
    `export interface ValidatedPurchaseReceiptLine {\n  readonly purchaseOrderLineId: string;\n  readonly acceptedQuantityScaled: bigint;\n}\n`,
    `export interface ValidatedPurchaseReceiptLine {\n  readonly purchaseOrderLineId: string;\n  readonly acceptedQuantityScaled: bigint;\n  readonly inventoryValueMinor: bigint | null;\n}\n`,
  );
  next = replaceOnce(
    next,
    'validate receipt acquisition value',
    `  ).map((line) => ({\n    purchaseOrderLineId: line.purchaseOrderLineId,\n    acceptedQuantityScaled: parsePositiveScaled(\n      line.acceptedQuantityScaled,\n      'acceptedQuantityScaled',\n    ),\n  }));\n`,
    `  ).map((line) => ({\n    purchaseOrderLineId: line.purchaseOrderLineId,\n    acceptedQuantityScaled: parsePositiveScaled(\n      line.acceptedQuantityScaled,\n      'acceptedQuantityScaled',\n    ),\n    inventoryValueMinor:\n      line.inventoryValueMinor === undefined\n        ? null\n        : inPurchasingVocabulary(() =>\n            parseNonNegativeMinor(line.inventoryValueMinor ?? '', 'inventoryValueMinor'),\n          ),\n  }));\n`,
  );
  next = replaceOnce(
    next,
    'receipt canonical form',
    `export function canonicalPurchaseReceiptForm(request: PurchaseReceiptRequest): readonly unknown[] {\n  const validated = validatePurchaseReceiptRequest(request);\n  return [\n    'purchasing-receipt-create.v1',\n    validated.purchaseOrderId,\n    validated.reference,\n    validated.lines.map((line) => [\n      line.purchaseOrderLineId,\n      line.acceptedQuantityScaled.toString(),\n    ]),\n  ];\n}\n`,
    `export function canonicalPurchaseReceiptForm(request: PurchaseReceiptRequest): readonly unknown[] {\n  const validated = validatePurchaseReceiptRequest(request);\n  const carriesInventoryValue = validated.lines.some((line) => line.inventoryValueMinor !== null);\n\n  // Compatibility is an idempotency invariant, not a convenience. A 5B\n  // receipt with no cost evidence must fingerprint byte-for-byte as it did\n  // before 5C, or a lawful retry after deployment would become a conflict.\n  if (!carriesInventoryValue) {\n    return [\n      'purchasing-receipt-create.v1',\n      validated.purchaseOrderId,\n      validated.reference,\n      validated.lines.map((line) => [\n        line.purchaseOrderLineId,\n        line.acceptedQuantityScaled.toString(),\n      ]),\n    ];\n  }\n\n  return [\n    'purchasing-receipt-create.v2',\n    validated.purchaseOrderId,\n    validated.reference,\n    validated.lines.map((line) => [\n      line.purchaseOrderLineId,\n      line.acceptedQuantityScaled.toString(),\n      line.inventoryValueMinor === null ? null : line.inventoryValueMinor.toString(),\n    ]),\n  ];\n}\n`,
  );
  return next;
});

transform('packages/domain/src/purchasing/__tests__/purchasing.test.ts', (source) => {
  if (source.includes('preserves the exact legacy v1 receipt form')) return source;
  let next = replaceOnce(
    source,
    'receipt request costing tests',
    `  it('refuses a zero or negative accepted quantity', () => {\n`,
    `  it('accepts an exact total inventory value, including known zero cost', () => {\n    const valued = validatePurchaseReceiptRequest(\n      receipt({\n        lines: [\n          {\n            purchaseOrderLineId: LINE_A,\n            acceptedQuantityScaled: '30000',\n            inventoryValueMinor: '0',\n          },\n        ],\n      }),\n    );\n    expect(valued.lines[0]?.inventoryValueMinor).toBe(0n);\n\n    expect(\n      refusalOf(() =>\n        validatePurchaseReceiptRequest(\n          receipt({\n            lines: [\n              {\n                purchaseOrderLineId: LINE_A,\n                acceptedQuantityScaled: '30000',\n                inventoryValueMinor: '1.5',\n              },\n            ],\n          }),\n        ),\n      ),\n    ).toBe('invalid-money');\n    expect(\n      refusalOf(() =>\n        validatePurchaseReceiptRequest(\n          receipt({\n            lines: [\n              {\n                purchaseOrderLineId: LINE_A,\n                acceptedQuantityScaled: '30000',\n                inventoryValueMinor: '9223372036854775808',\n              },\n            ],\n          }),\n        ),\n      ),\n    ).toBe('invalid-money');\n  });\n\n  it('refuses a zero or negative accepted quantity', () => {\n`,
  );
  next = replaceOnce(
    next,
    'canonical request form compatibility tests',
    `describe('canonical request forms', () => {\n`,
    `describe('canonical request forms', () => {\n  it('preserves the exact legacy v1 receipt form when inventory value is omitted', () => {\n    expect(canonicalPurchaseReceiptForm(receipt())).toEqual([\n      'purchasing-receipt-create.v1',\n      PO,\n      null,\n      [[LINE_A, '30000']],\n    ]);\n  });\n\n  it('uses v2 only for cost-bearing receipts and binds exact value into intent', () => {\n    const valued = canonicalPurchaseReceiptForm(\n      receipt({\n        lines: [\n          {\n            purchaseOrderLineId: LINE_A,\n            acceptedQuantityScaled: '30000',\n            inventoryValueMinor: '0',\n          },\n        ],\n      }),\n    );\n    expect(valued).toEqual([\n      'purchasing-receipt-create.v2',\n      PO,\n      null,\n      [[LINE_A, '30000', '0']],\n    ]);\n    expect(\n      JSON.stringify(\n        canonicalPurchaseReceiptForm(\n          receipt({\n            lines: [\n              {\n                purchaseOrderLineId: LINE_A,\n                acceptedQuantityScaled: '30000',\n                inventoryValueMinor: '1',\n              },\n            ],\n          }),\n        ),\n      ),\n    ).not.toBe(JSON.stringify(valued));\n  });\n\n`,
  );
  return next;
});

transform('apps/api/src/routes/purchasing-admin.ts', (source) => {
  if (source.includes('MAX_POSTGRES_BIGINT_MINOR')) return source;
  let next = replaceOnce(
    source,
    'http money boundary',
    `const UNSIGNED_SCALED = z\n  .string()\n  .regex(/^(0|[1-9][0-9]{0,17})$/, 'must be a non-negative integer string');\n`,
    `const UNSIGNED_SCALED = z\n  .string()\n  .regex(/^(0|[1-9][0-9]{0,17})$/, 'must be a non-negative integer string');\n\nconst MAX_POSTGRES_BIGINT_MINOR = (1n << 63n) - 1n;\nconst NON_NEGATIVE_MINOR = z\n  .string()\n  .regex(/^(0|[1-9][0-9]*)$/, 'must be a canonical non-negative integer string')\n  .refine((value) => BigInt(value) <= MAX_POSTGRES_BIGINT_MINOR, 'must fit PostgreSQL BIGINT');\n`,
  );
  next = replaceOnce(
    next,
    'receipt http acquisition value',
    `        z.object({ purchaseOrderLineId: UUID, acceptedQuantityScaled: UNSIGNED_SCALED }).strict(),\n`,
    `        z\n          .object({\n            purchaseOrderLineId: UUID,\n            acceptedQuantityScaled: UNSIGNED_SCALED,\n            inventoryValueMinor: NON_NEGATIVE_MINOR.optional(),\n          })\n          .strict(),\n`,
  );
  next = replaceOnce(
    next,
    'invalid money message',
    `  'invalid-reference': 'الرقم المرجعي غير صالح.',\n`,
    `  'invalid-reference': 'الرقم المرجعي غير صالح.',\n  'invalid-money': 'قيمة المخزون غير صالحة.',\n`,
  );
  next = replaceOnce(
    next,
    'invalid money status',
    `  'invalid-reference': 422,\n`,
    `  'invalid-reference': 422,\n  'invalid-money': 422,\n`,
  );
  next = replaceOnce(
    next,
    'cost-bearing receipt permission gate',
    `      const parsed = receiptBody.safeParse(request.body);\n      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });\n\n      const result = await service.receive(principal, {\n`,
    `      const parsed = receiptBody.safeParse(request.body);\n      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });\n\n      // Receiving quantity and establishing acquisition value are separate\n      // authorities. A receiver may still accept goods with unknown cost, but\n      // any explicit inventory value additionally requires costing authority.\n      if (\n        parsed.data.lines.some((line) => line.inventoryValueMinor !== undefined) &&\n        !principal.permissions.includes('inventory.cost.manage')\n      ) {\n        return reply.code(403).send({ error: 'forbidden' });\n      }\n\n      const result = await service.receive(principal, {\n`,
  );
  return next;
});

transform('apps/api/src/__tests__/purchasing-admin-routes.test.ts', (source) => {
  if (source.includes('requires inventory.cost.manage only when a receipt states acquisition value')) {
    return source;
  }
  let next = replaceOnce(
    source,
    'receipt costing permission tests',
    `  it('lets a holder of all three do all of it', async () => {\n`,
    `  it('requires inventory.cost.manage only when a receipt states acquisition value', async () => {\n    const receiver = await build(['purchasing.receive']);\n    const receiverCookie = await cookieFor(receiver);\n\n    const costed = await send('POST', '/v1/admin/purchasing/receipts', receiverCookie, {\n      ...RECEIPT_BODY,\n      lines: [\n        {\n          purchaseOrderLineId: ORDER_LINE,\n          acceptedQuantityScaled: '30000',\n          inventoryValueMinor: '4500',\n        },\n      ],\n    });\n    expect(costed.statusCode).toBe(403);\n    expect(costed.json()).toEqual({ error: 'forbidden' });\n    expect(seen).toHaveLength(0);\n\n    const unknownCost = await send('POST', '/v1/admin/purchasing/receipts', receiverCookie, {\n      ...RECEIPT_BODY,\n      operationId: 'op-receipt-unknown',\n    });\n    expect(unknownCost.statusCode).toBe(201);\n    expect(seen).toHaveLength(1);\n    await receiver.close();\n\n    const costManager = await build(['purchasing.receive', 'inventory.cost.manage']);\n    const costManagerCookie = await cookieFor(costManager);\n    const knownZero = await send('POST', '/v1/admin/purchasing/receipts', costManagerCookie, {\n      ...RECEIPT_BODY,\n      operationId: 'op-receipt-zero',\n      lines: [\n        {\n          purchaseOrderLineId: ORDER_LINE,\n          acceptedQuantityScaled: '30000',\n          inventoryValueMinor: '0',\n        },\n      ],\n    });\n    expect(knownZero.statusCode).toBe(201);\n    const request = seen.at(0)?.request as PurchaseReceiptRequest;\n    expect(request.lines[0]?.inventoryValueMinor).toBe('0');\n  });\n\n  it('lets a holder of all three do all of it', async () => {\n`,
  );
  next = replaceOnce(
    next,
    'receipt invalid money http test',
    `  it('maps every typed refusal to a stable status and an Arabic message', async () => {\n`,
    `  it('refuses non-canonical or out-of-range inventory value before authority execution', async () => {\n    const server = await build(ROLE_PERMISSIONS.owner);\n    const cookie = await cookieFor(server);\n    for (const inventoryValueMinor of ['1.5', '01', '9223372036854775808']) {\n      const response = await send('POST', '/v1/admin/purchasing/receipts', cookie, {\n        ...RECEIPT_BODY,\n        lines: [\n          {\n            purchaseOrderLineId: ORDER_LINE,\n            acceptedQuantityScaled: '30000',\n            inventoryValueMinor,\n          },\n        ],\n      });\n      expect(response.statusCode, inventoryValueMinor).toBe(400);\n      expect(response.json(), inventoryValueMinor).toEqual({ error: 'invalid_body' });\n    }\n    expect(seen).toHaveLength(0);\n  });\n\n  it('maps every typed refusal to a stable status and an Arabic message', async () => {\n`,
  );
  return next;
});

transform('packages/database/src/purchasing/receiving.ts', (source) => {
  if (source.includes('inventoryValueMinor: entry.inventoryValueMinor')) return source;
  let next = replaceOnce(
    source,
    'receipt locked request value',
    `        return { accepted: line.acceptedQuantityScaled, line: held };\n`,
    `        return {\n          accepted: line.acceptedQuantityScaled,\n          inventoryValueMinor: line.inventoryValueMinor,\n          line: held,\n        };\n`,
  );
  next = replaceOnce(
    next,
    'receipt movement acquisition basis',
    `        const applied = await applyMovementWithin(\n          tx,\n          tenant,\n          {\n            id: newId(),\n            branchId: order.branchId,\n            productId: entry.line.productId,\n            kind: PURCHASING_MOVEMENT_KIND,\n            quantityScaled: entry.accepted.toString(),\n            reason: null,\n            sourceType: PURCHASING_SOURCE_TYPES.purchaseReceipt,\n            sourceId: receiptId,\n            actorUserId: actor.userId,\n            occurredAt: at.toISOString(),\n          },\n          // Receiving only ever adds, so no floor can be crossed and the\n          // primitive is not asked to evaluate one.\n          true,\n          receiptLineId,\n        );\n`,
    `        const incomingCostBasis =\n          entry.inventoryValueMinor === null\n            ? undefined\n            : {\n                knownQuantityScaled: entry.accepted,\n                unknownQuantityScaled: 0n,\n                knownValueMinor: entry.inventoryValueMinor,\n              };\n        const applied = await applyMovementWithin(\n          tx,\n          tenant,\n          {\n            id: newId(),\n            branchId: order.branchId,\n            productId: entry.line.productId,\n            kind: PURCHASING_MOVEMENT_KIND,\n            quantityScaled: entry.accepted.toString(),\n            reason: null,\n            sourceType: PURCHASING_SOURCE_TYPES.purchaseReceipt,\n            sourceId: receiptId,\n            actorUserId: actor.userId,\n            occurredAt: at.toISOString(),\n          },\n          // Receiving only ever adds, so no floor can be crossed and the\n          // primitive is not asked to evaluate one.\n          true,\n          receiptLineId,\n          incomingCostBasis,\n        );\n`,
  );
  next = replaceOnce(
    next,
    'receipt line cost evidence persistence',
    `            resultRevision: applied.revision,\n          },\n        });\n`,
    `            resultRevision: applied.revision,\n            inventoryValueMinor: entry.inventoryValueMinor,\n            costKnownQuantityScaled: applied.cost.knownQuantityScaled,\n            costUnknownQuantityScaled: applied.cost.unknownQuantityScaled,\n            costValueMinor: applied.cost.knownValueMinor,\n            costProvenance: applied.cost.provenance,\n          },\n        });\n`,
  );
  return next;
});
