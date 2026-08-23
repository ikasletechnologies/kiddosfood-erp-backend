import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

// Reasons the UI is allowed to submit — kept in sync with the frontend's
// dropdown. "Other" additionally requires reasonNotes (enforced below).
const VALID_REASONS = [
  'Failed safety test',
  'Contamination',
  'Packaging defect',
  'Incorrect labeling',
  'Customer complaint',
  'Expiry issue',
  'Other',
];

// Statuses that make a ProductBatch's QC-approved quantity real, distributable
// finished-goods stock. PENDING/REWORK never entered inventory (see
// inspectBatch in production.service.ts — stock is only credited on this
// same transition), and REJECTED batches had approvedQty forced to 0.
const QC_ELIGIBLE_STATUSES = ['APPROVED', 'PARTIALLY_APPROVED'];

export class RecallService {
  // Single shared eligibility check — both the eligibility endpoint and
  // initiateRecall() (inside its own transaction, to close the check/act
  // race) call this same logic so the two can never disagree.
  private static evaluateEligibility(batch: {
    qcStatus: string | null;
    approvedQty: number | null;
  }, existingRecall: { status: string } | null): string[] {
    const reasons: string[] = [];

    if (!QC_ELIGIBLE_STATUSES.includes(batch.qcStatus || '')) {
      if (batch.qcStatus === 'PENDING') {
        reasons.push('This batch is still pending QC inspection and has not been released to distributable stock.');
      } else if (batch.qcStatus === 'REJECTED') {
        reasons.push('This batch was rejected at QC and never entered distributable stock.');
      } else {
        reasons.push(`Batch QC status (${batch.qcStatus || 'UNKNOWN'}) is not eligible for recall.`);
      }
    }

    if ((batch.approvedQty || 0) <= 0) {
      reasons.push('This batch has no approved/output quantity available for recall.');
    }

    if (existingRecall?.status === 'IN_PROGRESS') {
      reasons.push('A recall is already in progress for this batch.');
    } else if (existingRecall?.status === 'COMPLETED') {
      reasons.push('This batch has already been recalled and the recall is complete.');
    }

    return reasons;
  }

  // Authoritative quantity + unit resolution for a batch. Never defaults to
  // 0/"KG" silently — every figure is read from the same fields
  // production/QC actually wrote (ProductBatch.quantity/approvedQty/
  // rejectionQty/packagedQty/cartonedQty) plus InventoryBatch, which is the
  // only place "how much of this lot is still on hand vs. gone out the door"
  // actually lives.
  static async getBatchQuantities(productBatchId: string) {
    const batch = await prisma.productBatch.findUnique({
      where: { id: productBatchId },
      include: {
        product: true,
        production: { include: { recipe: true } },
      },
    });
    if (!batch) return null;

    const inventoryBatches = await prisma.inventoryBatch.findMany({
      where: { productBatchId },
      include: { inventoryItem: true, warehouse: true },
    });

    const unit = batch.production?.recipe?.yieldUnit
      || inventoryBatches[0]?.inventoryItem?.unit
      || 'KG';

    const availableQty = inventoryBatches.reduce((s, b) => s + b.currentQty, 0);
    // "Left the lot" — consumed by any outbound movement (sale, dispatch,
    // transfer, waste). Distribution-specific breakdown comes from
    // locateDistribution(); this is the top-line total.
    const distributedQty = inventoryBatches.reduce((s, b) => s + Math.max(0, b.initialQty - b.currentQty), 0);

    return {
      batch,
      unit,
      producedQty: batch.quantity || 0,
      approvedQty: batch.approvedQty || 0,
      rejectedQty: batch.rejectionQty || 0,
      packagedQty: batch.packagedQty || 0,
      cartonedQty: batch.cartonedQty || 0,
      availableQty,
      distributedQty,
      inventoryBatches,
    };
  }

  static async checkEligibility(productBatchId: string) {
    const quantities = await this.getBatchQuantities(productBatchId);
    if (!quantities) return { eligible: false, reasons: ['Batch not found.'], batch: null };

    const recall = await prisma.batchRecall.findUnique({ where: { productBatchId } });
    const reasons = this.evaluateEligibility(quantities.batch, recall);

    return {
      eligible: reasons.length === 0,
      reasons,
      batch: {
        id: quantities.batch.id,
        batchCode: quantities.batch.batchCode,
        productName: quantities.batch.product?.name,
        qcStatus: quantities.batch.qcStatus,
        unit: quantities.unit,
        producedQty: quantities.producedQty,
        approvedQty: quantities.approvedQty,
        rejectedQty: quantities.rejectedQty,
        packagedQty: quantities.packagedQty,
        cartonedQty: quantities.cartonedQty,
        availableQty: quantities.availableQty,
        distributedQty: quantities.distributedQty,
      },
      recall,
    };
  }

  static async getRecallState(productBatchId: string) {
    const recall = await prisma.batchRecall.findUnique({
      where: { productBatchId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    return recall;
  }

  static async initiateRecall(productBatchId: string, data: { reason: string; reasonNotes?: string; userId?: string }) {
    if (!VALID_REASONS.includes(data.reason)) {
      throw new Error(`Invalid recall reason. Must be one of: ${VALID_REASONS.join(', ')}`);
    }
    if (data.reason === 'Other' && !data.reasonNotes?.trim()) {
      throw new Error('Notes are required when recall reason is "Other".');
    }

    return prisma.$transaction(async (tx) => {
      const batch = await tx.productBatch.findUnique({
        where: { id: productBatchId },
        include: { production: { include: { recipe: true } } },
      });
      if (!batch) throw new Error('Batch not found.');
      const unit = batch.production?.recipe?.yieldUnit || 'KG';

      const existingRecall = await tx.batchRecall.findUnique({ where: { productBatchId } });
      const reasons = this.evaluateEligibility(batch, existingRecall);
      if (reasons.length > 0) throw new Error(reasons.join(' '));

      // Branch on the already-fetched `existingRecall` BEFORE issuing any
      // write, rather than attempting create() and catching a unique-
      // constraint violation — Postgres aborts the entire transaction on a
      // failed statement, so any recovery query issued on the same `tx`
      // after that error fails with "current transaction is aborted",
      // taking down the whole request instead of recovering it.
      let recall;
      if (!existingRecall) {
        try {
          recall = await tx.batchRecall.create({
            data: {
              productBatchId,
              status: 'IN_PROGRESS',
              step: 'INITIATED',
              reason: data.reason,
              reasonNotes: data.reasonNotes || null,
              initiatedBy: data.userId || null,
              initiatedAt: new Date(),
            },
          });
        } catch (e: any) {
          // Another request won the race to create the row first, in the
          // microseconds between our read above and this create. Nothing
          // more can be recovered on this (now-aborted) transaction — surface
          // a clean, retryable error and let the caller re-check state.
          if (e.code === 'P2002') {
            throw new Error('A recall was just initiated for this batch by another request. Please refresh and try again.');
          }
          throw e;
        }
      } else {
        // evaluateEligibility() above already rejected IN_PROGRESS/COMPLETED,
        // so the only row that can reach here is CANCELLED — reuse it via a
        // plain UPDATE (no unique-constraint risk) instead of create().
        const updated = await tx.batchRecall.updateMany({
          where: { productBatchId, status: 'CANCELLED' },
          data: {
            status: 'IN_PROGRESS',
            step: 'INITIATED',
            reason: data.reason,
            reasonNotes: data.reasonNotes || null,
            initiatedBy: data.userId || null,
            initiatedAt: new Date(),
            completedAt: null,
            cancelledAt: null,
            distributedQty: 0,
            returnedQty: 0,
            // Explicit JSON NULL, not `undefined` (which Prisma would treat
            // as "leave field untouched") — a re-initiated recall must not
            // carry over the previous CANCELLED attempt's distribution/report
            // snapshot.
            affectedLocations: Prisma.JsonNull,
            reportData: Prisma.JsonNull,
          },
        });
        if (updated.count === 0) {
          // Another request changed this row's status between our read and
          // this update (e.g. it re-initiated first) — updateMany matching
          // zero rows is not an error Postgres aborts on, so the transaction
          // is still healthy and this read is safe.
          throw new Error('A recall was just initiated for this batch by another request. Please refresh and try again.');
        }
        recall = await tx.batchRecall.findUniqueOrThrow({ where: { productBatchId } });
      }

      // Block remaining stock of this batch immediately — don't wait for a
      // separate "Block Sales" click to make it non-sellable. depleteBatchesFIFO
      // only ever draws from status: 'APPROVED' lots, so flipping this to
      // BLOCKED is a real, enforced block, not a cosmetic flag.
      const inventoryBatches = await tx.inventoryBatch.findMany({ where: { productBatchId } });
      const blockable = inventoryBatches.filter((b) => b.status === 'APPROVED');
      if (blockable.length) {
        await tx.inventoryBatch.updateMany({
          where: { id: { in: blockable.map((b) => b.id) } },
          data: { status: 'BLOCKED' },
        });
      }
      const blockedQty = blockable.reduce((s, b) => s + b.currentQty, 0);

      // Explicit about what this figure is (and isn't): only the stock still
      // sitting in warehouse right now. Anything already dispatched before the
      // recall started isn't in currentQty any more — that portion shows up
      // separately as "distributed" once locateDistribution runs, and the two
      // numbers are deliberately not meant to be summed with this one.
      const message = blockedQty > 0
        ? `${blockedQty} ${unit} of remaining warehouse stock quarantined (blocked from sale/dispatch). Any quantity already dispatched before this recall is tracked separately as distributed.`
        : 'No warehouse stock remained for this batch — nothing available to quarantine.';

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'RECALL_INITIATED',
          status: 'SUCCESS',
          actor: data.userId || 'system',
          affectedQty: blockedQty,
          details: { reason: data.reason, reasonNotes: data.reasonNotes || null, blockedInventoryBatchIds: blockable.map((b) => b.id), message },
        },
      });

      return recall;
    });
  }

  static async locateDistribution(productBatchId: string, userId?: string) {
    return prisma.$transaction(async (tx) => {
      const recall = await tx.batchRecall.findUnique({ where: { productBatchId } });
      if (!recall || recall.status !== 'IN_PROGRESS') throw new Error('No active recall in progress for this batch.');

      const batch = await tx.productBatch.findUnique({
        where: { id: productBatchId },
        include: { production: { include: { recipe: true } } },
      });
      const unit = batch?.production?.recipe?.yieldUnit || 'KG';

      const inventoryBatches = await tx.inventoryBatch.findMany({
        where: { productBatchId },
        include: { warehouse: true },
      });
      const inventoryBatchIds = inventoryBatches.map((b) => b.id);
      const distributedQty = inventoryBatches.reduce((s, b) => s + Math.max(0, b.initialQty - b.currentQty), 0);
      const availableWarehouseQty = inventoryBatches.reduce((s, b) => s + b.currentQty, 0);

      // Only outbound movements that trace back to this batch's own
      // InventoryBatch lot(s) — real StockMovement rows, never fabricated.
      // Note: recordMovement() only stamps a batchId when a movement drew
      // from exactly one lot (see inventory.service.ts), so a sale that
      // spanned multiple lots of this same batch is not individually
      // attributable here even though it is included in distributedQty above.
      const movements = inventoryBatchIds.length
        ? await tx.stockMovement.findMany({
            where: { batchId: { in: inventoryBatchIds }, quantity: { lt: 0 } },
            include: { warehouse: true },
          })
        : [];

      const orderIds = Array.from(new Set(movements.filter((m) => m.referenceType === 'ORDER').map((m) => m.referenceId).filter((id): id is string => !!id)));
      const franchiseOrderIds = Array.from(new Set(movements.filter((m) => m.referenceType === 'FRANCHISE_ORDER').map((m) => m.referenceId).filter((id): id is string => !!id)));

      const orders = orderIds.length
        ? await tx.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, invoiceNum: true, franchise: { select: { name: true } } } })
        : [];
      const franchiseOrders = franchiseOrderIds.length
        ? await tx.franchiseOrder.findMany({ where: { id: { in: franchiseOrderIds } }, select: { id: true, orderNumber: true, franchiseId: true, franchise: { select: { name: true } } } })
        : [];

      const locations = new Map<string, { type: string; label: string; qty: number }>();
      for (const m of movements) {
        const qty = Math.abs(m.quantity);
        let key: string;
        let type: string;
        let label: string;

        if (m.referenceType === 'ORDER') {
          const o = orders.find((x) => x.id === m.referenceId);
          key = `ORDER:${m.referenceId}`;
          type = 'POS_SALE';
          label = o ? `POS Sale ${o.invoiceNum} (${o.franchise?.name || 'HQ'})` : `POS Sale (${m.referenceId})`;
        } else if (m.referenceType === 'FRANCHISE_ORDER') {
          const fo = franchiseOrders.find((x) => x.id === m.referenceId);
          key = `FRANCHISE:${fo?.franchiseId || m.referenceId}`;
          type = 'FRANCHISE_OUTLET';
          label = fo ? `Franchise Outlet: ${fo.franchise?.name} (Order ${fo.orderNumber})` : `Franchise Outlet (${m.referenceId})`;
        } else {
          key = `OTHER:${m.referenceType || 'UNKNOWN'}:${m.warehouseId || m.id}`;
          type = m.referenceType || 'OTHER';
          label = m.warehouse?.name
            ? `${(m.referenceType || 'Movement').replace(/_/g, ' ')} — ${m.warehouse.name}`
            : (m.referenceType || 'Other Movement').replace(/_/g, ' ');
        }

        const existing = locations.get(key) || { type, label, qty: 0 };
        existing.qty += qty;
        locations.set(key, existing);
      }

      const affectedLocations = Array.from(locations.values());

      await tx.batchRecall.update({
        where: { productBatchId },
        data: { step: 'DISTRIBUTION_LOCATED', distributedQty, affectedLocations: affectedLocations as any },
      });

      // Explicit that this is stock which left BEFORE the recall — distinct
      // from, and not additive with, the warehouse-quarantine figure recorded
      // at RECALL_INITIATED.
      const message = affectedLocations.length
        ? `${distributedQty} ${unit} already dispatched before this recall, traced to ${affectedLocations.length} location(s).`
        : 'No stock had left the warehouse for this batch before the recall — nothing to trace.';

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'DISTRIBUTION_LOCATED',
          status: 'SUCCESS',
          actor: userId || 'system',
          affectedQty: distributedQty,
          details: { affectedLocations, availableWarehouseQty, message } as any,
        },
      });

      return { affectedLocations, distributedQty, availableWarehouseQty, message };
    });
  }

  static async blockSales(productBatchId: string, userId?: string) {
    return prisma.$transaction(async (tx) => {
      const recall = await tx.batchRecall.findUnique({ where: { productBatchId } });
      if (!recall || recall.status !== 'IN_PROGRESS') throw new Error('No active recall in progress for this batch.');
      if (recall.step === 'INITIATED') throw new Error('Locate distribution before blocking sales.');

      const batch = await tx.productBatch.findUnique({
        where: { id: productBatchId },
        include: { production: { include: { recipe: true } } },
      });
      const unit = batch?.production?.recipe?.yieldUnit || 'KG';

      const inventoryBatches = await tx.inventoryBatch.findMany({ where: { productBatchId } });
      const toBlock = inventoryBatches.filter((b) => b.status === 'APPROVED');
      if (toBlock.length) {
        await tx.inventoryBatch.updateMany({
          where: { id: { in: toBlock.map((b) => b.id) } },
          data: { status: 'BLOCKED' },
        });
      }
      const blockedNow = inventoryBatches.filter((b) => b.status === 'BLOCKED' || toBlock.includes(b));
      const blockedQty = blockedNow.reduce((s, b) => s + b.currentQty, 0);
      // toBlock.length > 0 means this step actually flipped fresh APPROVED lots
      // to BLOCKED (e.g. stock that only became available after Initiate ran).
      // The far more common case is toBlock being empty — Initiate already
      // blocked everything sellable, so this step is a re-confirmation
      // checkpoint on the SAME quantity, not an additional block.
      const newlyBlocked = toBlock.length > 0;

      await tx.batchRecall.update({ where: { productBatchId }, data: { step: 'SALES_BLOCKED' } });

      const message = blockedQty > 0
        ? newlyBlocked
          ? `${blockedQty} ${unit} newly blocked from sale across ${blockedNow.length} lot(s).`
          : `${blockedQty} ${unit} at warehouse confirmed blocked from sale (already quarantined at recall initiation — not an additional quantity).`
        : 'No sellable stock remained for this batch — nothing left to block.';

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'SALES_BLOCKED',
          status: 'SUCCESS',
          actor: userId || 'system',
          affectedQty: blockedQty,
          details: { blockedLots: blockedNow.length, message } as any,
        },
      });

      return { blockedQty, blockedLots: blockedNow.length, message };
    });
  }

  static async generateReport(productBatchId: string, userId?: string) {
    return prisma.$transaction(async (tx) => {
      const recall = await tx.batchRecall.findUnique({ where: { productBatchId } });
      if (!recall || recall.status !== 'IN_PROGRESS') throw new Error('No active recall in progress for this batch.');
      if (recall.step === 'INITIATED') throw new Error('Locate distribution before generating the recall report.');

      const quantities = await this.getBatchQuantities(productBatchId);
      if (!quantities) throw new Error('Batch not found.');

      const report = {
        recallId: recall.id,
        batchCode: quantities.batch.batchCode,
        productName: quantities.batch.product?.name,
        productionDate: quantities.batch.production?.startTime || quantities.batch.mfgDate || quantities.batch.createdAt,
        qcStatus: quantities.batch.qcStatus,
        unit: quantities.unit,
        producedQty: quantities.producedQty,
        approvedQty: quantities.approvedQty,
        rejectedQty: quantities.rejectedQty,
        distributedQty: recall.distributedQty,
        currentWarehouseQty: quantities.availableQty,
        affectedLocations: recall.affectedLocations,
        returnedQty: recall.returnedQty,
        pendingQty: Math.max(0, recall.distributedQty - recall.returnedQty),
        reason: recall.reason,
        reasonNotes: recall.reasonNotes,
        initiatedBy: recall.initiatedBy,
        initiatedAt: recall.initiatedAt,
        status: recall.status,
        generatedAt: new Date(),
      };

      await tx.batchRecall.update({
        where: { productBatchId },
        data: { step: 'REPORT_GENERATED', reportData: report as any },
      });

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'REPORT_GENERATED',
          status: 'SUCCESS',
          actor: userId || 'system',
          details: { message: 'Recall report generated with real traceability data.' } as any,
        },
      });

      return report;
    });
  }

  static async collectReturn(productBatchId: string, returnedQty: number, userId?: string) {
    return prisma.$transaction(async (tx) => {
      const recall = await tx.batchRecall.findUnique({ where: { productBatchId } });
      if (!recall || recall.status !== 'IN_PROGRESS') throw new Error('No active recall in progress for this batch.');
      if (recall.step === 'INITIATED') throw new Error('Locate distribution and block sales before collecting returns.');

      const qty = Number(returnedQty);
      if (!Number.isFinite(qty) || qty < 0) throw new Error('Returned quantity must be a non-negative number.');

      const newReturnedTotal = recall.returnedQty + qty;
      if (newReturnedTotal > recall.distributedQty + 0.001) {
        throw new Error(`Returned quantity cannot exceed the distributed quantity (${recall.distributedQty}). Already returned: ${recall.returnedQty}.`);
      }

      if (qty > 0) {
        const inventoryBatches = await tx.inventoryBatch.findMany({ where: { productBatchId } });
        const target = inventoryBatches[0];
        if (!target) throw new Error('No inventory lot found for this batch to receive the returned stock.');

        // Stays in a non-sellable state (RETURNED, not APPROVED) — quarantine,
        // not silently back into sellable stock. depleteBatchesFIFO only ever
        // draws from status: 'APPROVED'.
        await tx.inventoryBatch.update({
          where: { id: target.id },
          data: { currentQty: { increment: qty }, status: 'RETURNED' },
        });
        await tx.inventoryItem.update({
          where: { id: target.inventoryItemId },
          data: { currentStock: { increment: qty } },
        });
        await tx.stockMovement.create({
          data: {
            itemId: target.inventoryItemId,
            movementType: 'RECALL_RETURN_IN',
            quantity: qty,
            referenceType: 'RECALL',
            referenceId: recall.id,
            batchId: target.id,
            note: `Returned stock collected for recall of batch ${productBatchId}`,
            createdBy: userId,
            warehouseId: target.warehouseId,
          },
        });
      }

      const step = recall.step === 'REPORT_GENERATED' || recall.step === 'RETURN_COLLECTED' ? 'RETURN_COLLECTED' : recall.step;
      await tx.batchRecall.update({ where: { productBatchId }, data: { returnedQty: newReturnedTotal, step } });

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'RETURN_COLLECTED',
          status: 'SUCCESS',
          actor: userId || 'system',
          affectedQty: qty,
          details: { returnedQtyTotal: newReturnedTotal, distributedQty: recall.distributedQty } as any,
        },
      });

      return { returnedQty: newReturnedTotal, distributedQty: recall.distributedQty, pendingQty: Math.max(0, recall.distributedQty - newReturnedTotal) };
    });
  }

  static async completeRecall(productBatchId: string, userId?: string) {
    return prisma.$transaction(async (tx) => {
      const recall = await tx.batchRecall.findUnique({ where: { productBatchId } });
      if (!recall || recall.status !== 'IN_PROGRESS') throw new Error('No active recall in progress for this batch.');
      if (recall.distributedQty > 0 && recall.returnedQty < recall.distributedQty - 0.001) {
        throw new Error(`Cannot complete recall — ${(recall.distributedQty - recall.returnedQty).toFixed(2)} unit(s) are still pending return.`);
      }

      const updated = await tx.batchRecall.update({
        where: { productBatchId },
        data: { status: 'COMPLETED', step: 'COMPLETED', completedAt: new Date() },
      });

      await tx.batchRecallEvent.create({
        data: { recallId: recall.id, event: 'RECALL_COMPLETED', status: 'SUCCESS', actor: userId || 'system' },
      });

      return updated;
    });
  }

  static async cancelRecall(productBatchId: string, note: string | undefined, userId?: string) {
    return prisma.$transaction(async (tx) => {
      const recall = await tx.batchRecall.findUnique({ where: { productBatchId } });
      if (!recall || recall.status !== 'IN_PROGRESS') throw new Error('No active recall in progress for this batch.');

      // Release whatever this recall blocked back to sellable stock. Lots
      // that received returned stock (status RETURNED) are left as-is —
      // cancelling a recall shouldn't silently make physically-quarantined
      // returned goods sellable again.
      await tx.inventoryBatch.updateMany({
        where: { productBatchId, status: 'BLOCKED' },
        data: { status: 'APPROVED' },
      });

      const updated = await tx.batchRecall.update({
        where: { productBatchId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      await tx.batchRecallEvent.create({
        data: { recallId: recall.id, event: 'RECALL_CANCELLED', status: 'SUCCESS', actor: userId || 'system', details: note ? ({ note } as any) : undefined },
      });

      return updated;
    });
  }
}
