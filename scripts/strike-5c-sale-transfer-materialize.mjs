import { readFileSync, writeFileSync } from 'node:fs';

function transform(path, work) {
  const before = readFileSync(path, 'utf8');
  const after = work(before);
  if (after !== before) writeFileSync(path, after);
}

function replaceOnce(text, label, before, after) {
  const first = text.indexOf(before);
  if (first === -1) throw new Error(`5C integration anchor missing: ${label}`);
  if (text.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C integration anchor is not unique: ${label}`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

transform('packages/database/src/repositories/sale-repository.ts', (source) => {
  if (source.includes('Sale movement cost basis does not reconcile to its sale line.'))
    return source;

  let next = replaceOnce(
    source,
    'new sale line explicit unknown basis',
    `            netMinor: BigInt(line.netMinor),\n            vatMinor: BigInt(line.vatMinor),\n            totalMinor: BigInt(line.totalMinor),\n          })),\n`,
    `            netMinor: BigInt(line.netMinor),\n            vatMinor: BigInt(line.vatMinor),\n            totalMinor: BigInt(line.totalMinor),\n            // A new line has no historical ambiguity: if it does not produce a\n            // tracked-stock movement its inventory basis is explicitly unknown.\n            // Tracked lines are replaced below, in this same transaction, by\n            // the exact basis their sale movement consumed.\n            costKnownQuantityScaled: 0n,\n            costUnknownQuantityScaled: BigInt(line.quantityScaled),\n            costValueMinor: 0n,\n            costProvenance: 'unknown',\n          })),\n`,
  );

  next = replaceOnce(
    next,
    'sale movement freezes cost basis',
    `        for (const movement of inventory) {\n          // The guard is in the UPDATE, not in a prior read: two tills selling\n          // the last unit both saw one in stock, and only this can tell them\n          // apart. A refusal aborts the whole transaction.\n          await applyMovementWithin(tx, tenant, movement, allowNegativeStock);\n        }\n`,
    `        // A checkout already refuses duplicate product lines. Assert the\n        // same invariant again at the persistence boundary so every tracked\n        // movement has exactly one immutable sale line on which to freeze its\n        // original cost basis.\n        const saleLineByProduct = new Map(\n          sale.lines\n            .filter((line) => line.productId !== null)\n            .map((line) => [line.productId as string, line] as const),\n        );\n        if (saleLineByProduct.size !== sale.lines.filter((line) => line.productId !== null).length) {\n          throw new DatabaseError('A sale cannot contain duplicate product lines at persistence.');\n        }\n\n        for (const movement of inventory) {\n          const saleLine = saleLineByProduct.get(movement.productId);\n          if (saleLine === undefined) {\n            throw new DatabaseError('A sale stock movement has no matching sale line for cost basis.');\n          }\n          const movementQuantity = BigInt(movement.quantityScaled);\n          const lineQuantity = BigInt(saleLine.quantityScaled);\n          if (movementQuantity >= 0n || -movementQuantity !== lineQuantity) {\n            throw new DatabaseError('Sale movement cost basis does not reconcile to its sale line.');\n          }\n\n          // The guard is in the stock UPDATE, not in a prior read: two tills\n          // selling the last unit both saw one in stock, and only the mutation\n          // can tell them apart. Costing runs under the same locked stock row.\n          const applied = await applyMovementWithin(\n            tx,\n            tenant,\n            movement,\n            allowNegativeStock,\n            saleLine.id,\n          );\n\n          // Frozen before commit. A future return reads these four fields from\n          // the original sale line and never consults today's branch average.\n          await tx.saleLine.update({\n            where: { tenantId_id: { tenantId: tenant, id: saleLine.id } },\n            data: {\n              costKnownQuantityScaled: applied.cost.knownQuantityScaled,\n              costUnknownQuantityScaled: applied.cost.unknownQuantityScaled,\n              costValueMinor: applied.cost.knownValueMinor,\n              costProvenance: applied.cost.provenance,\n            },\n          });\n        }\n`,
  );
  return next;
});

transform('packages/database/src/inventory/stock-ledger.ts', (source) => {
  if (
    source.includes('Transfer cost basis changed between source and destination movement evidence.')
  ) {
    return source;
  }

  return replaceOnce(
    source,
    'transfer destination receives exact source basis',
    `      const into = await applyMovementWithin(\n        tx,\n        tenant,\n        {\n          id: newId(),\n          branchId: plan.toBranchId,\n          productId: line.productId,\n          kind: 'transfer',\n          quantityScaled: line.quantityScaled.toString(),\n          reason: plan.reason,\n          sourceType: STOCK_SOURCE_TYPES.transfer,\n          sourceId: documentId,\n          actorUserId: actor.userId,\n          occurredAt: at.toISOString(),\n        },\n        true,\n        lineId,\n      );\n\n      await tx.inventoryTransferLine.create({\n`,
    `      // The destination receives the exact basis the source movement just\n      // consumed. This is the transfer valuation conservation boundary: no\n      // branch can manufacture a fresh average, and no value can disappear\n      // between the two legs. If the destination is negative, the shared\n      // costing authority records any known value used to fill that deficit as\n      // catch-up evidence rather than pretending it remains an inventory asset.\n      const into = await applyMovementWithin(\n        tx,\n        tenant,\n        {\n          id: newId(),\n          branchId: plan.toBranchId,\n          productId: line.productId,\n          kind: 'transfer',\n          quantityScaled: line.quantityScaled.toString(),\n          reason: plan.reason,\n          sourceType: STOCK_SOURCE_TYPES.transfer,\n          sourceId: documentId,\n          actorUserId: actor.userId,\n          occurredAt: at.toISOString(),\n        },\n        true,\n        lineId,\n        out.cost,\n      );\n\n      if (\n        into.cost.knownQuantityScaled !== out.cost.knownQuantityScaled ||\n        into.cost.unknownQuantityScaled !== out.cost.unknownQuantityScaled ||\n        into.cost.knownValueMinor !== out.cost.knownValueMinor\n      ) {\n        throw new Error(\n          'Transfer cost basis changed between source and destination movement evidence.',\n        );\n      }\n\n      await tx.inventoryTransferLine.create({\n`,
  );
});
