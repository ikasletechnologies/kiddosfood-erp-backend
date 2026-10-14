import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { ProductionFlags } from './production.flags';

// Recall severity (food-safety classification), captured at initiation.
export const RECALL_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// A recall disposal is an ordinary WASTE_OUT movement (referenceType 'WASTE',
// so the existing wasted-quantity figures in getBatchQuantities keep
// reconciling) whose referenceId is the recall — that is what tells it apart
// from an everyday damage/spoilage write-off.
const DISPOSAL_REFERENCE_TYPE = 'WASTE';

// Business lifecycle shown to users, derived from existing columns + the
// immutable event log (no new enum values):
//   INITIATED   status IN_PROGRESS, step INITIATED
//   IN_PROGRESS status IN_PROGRESS, distribution located / blocking / recovery under way
//   RECONCILED  status IN_PROGRESS with a reconciliation still matching current stock
//   CLOSED      status COMPLETED
//   CANCELLED   status CANCELLED (quarantine released by an authorised, noted decision)
export type RecallLifecycle = 'INITIATED' | 'IN_PROGRESS' | 'RECONCILED' | 'CLOSED' | 'CANCELLED';

// Rounds away float noise so reconciliation snapshots compare reliably.
const r3 = (n: number) => Math.round((n || 0) * 1000) / 1000;

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
// QC_NOT_REQUIRED batches (released to packaging with production QC switched
// off — see production.flags.ts) are distributable stock too and must stay
// recallable for food-safety traceability.
const QC_ELIGIBLE_STATUSES = ['APPROVED', 'PARTIALLY_APPROVED', 'QC_NOT_REQUIRED'];

// StockMovement.referenceType values that represent stock genuinely leaving
// the warehouse to an external party (a customer, a franchise outlet,
// another warehouse) — the only kind of outbound movement a recall can
// meaningfully ask someone to "return." A batch's currentQty can also drop
// for reasons that have nothing to do with distribution — WASTE (damage/
// spoilage write-off, destroyed, not returnable), ADJUSTMENT/BIN_ASSIGNMENT
// (internal moves that usually net to zero), PACKAGING (bulk -> packaged
// conversion within the same warehouse) — none of those should ever count
// toward "distributed," be listed as an affected location, or be eligible
// for "Collect Returned Stock."
const GENUINE_DISTRIBUTION_REFERENCE_TYPES = ['ORDER', 'FRANCHISE_ORDER', 'SALE', 'DELIVERY_CHALLAN', 'TRANSFER'];

export class RecallService {
  // Single shared eligibility check — both the eligibility endpoint and
  // initiateRecall() (inside its own transaction, to close the check/act
  // race) call this same logic so the two can never disagree.
  private static evaluateEligibility(batch: {
    qcStatus: string | null;
    approvedQty: number | null;
    quantity?: number | null;
  }, existingRecall: { status: string } | null): string[] {
    const reasons: string[] = [];

    // With production QC switched off, a completed batch can still be at
    // PENDING simply because nothing has been packed from it yet (it is
    // released inside its first Confirm Packaging). Recalling it is valid —
    // there is no stock to quarantine yet, but the recall keeps its bulk out
    // of packaging.
    const unreleasedWithoutQc = (batch.qcStatus || 'PENDING') === 'PENDING' && !ProductionFlags.qcEnabled;

    if (!QC_ELIGIBLE_STATUSES.includes(batch.qcStatus || '') && !unreleasedWithoutQc) {
      if (batch.qcStatus === 'PENDING') {
        reasons.push('This batch is still pending QC inspection and has not been released to distributable stock.');
      } else if (batch.qcStatus === 'REJECTED') {
        reasons.push('This batch was rejected at QC and never entered distributable stock.');
      } else {
        reasons.push(`Batch QC status (${batch.qcStatus || 'UNKNOWN'}) is not eligible for recall.`);
      }
    }

    const outputQty = unreleasedWithoutQc ? (batch.quantity || 0) : (batch.approvedQty || 0);
    if (outputQty <= 0) {
      reasons.push('This batch has no approved/output quantity available for recall.');
    }

    if (existingRecall?.status === 'IN_PROGRESS') {
      reasons.push('A recall is already in progress for this batch.');
    } else if (existingRecall?.status === 'COMPLETED') {
      reasons.push('This batch has already been recalled and the recall is complete.');
    }

    return reasons;
  }

  // A recalled batch's approved bulk output sits in a bulk InventoryItem
  // pool shared with every other ProductBatch of the same recipe — FIFO in
  // startPackaging() has no productBatchId scoping (by design, see the
  // production-costing investigation), so a packaging run nominally "for"
  // another batch can have actually drawn on THIS batch's bulk lot. That
  // packaging run's ProductPackaging.bulkBreakdown (recorded at reservation
  // time) is the only place this cross-batch consumption is recorded — the
  // resulting retail InventoryBatch is tagged with the OTHER batch's
  // productBatchId, so a plain `InventoryBatch WHERE productBatchId = X`
  // lookup can never find it. This walks bulkBreakdown to find every other
  // ProductBatch whose retail output may therefore contain this batch's
  // material, so a recall can't silently miss it.
  private static async findCrossBatchAffectedIds(tx: any, productBatchId: string, recipeId: string | undefined): Promise<string[]> {
    if (!recipeId) return [];
    const packagings = await tx.productPackaging.findMany({
      where: {
        bulkBreakdown: { not: Prisma.JsonNull },
        batch: { production: { recipeId } },
      },
      select: { batchId: true, bulkBreakdown: true },
    });
    const affected = new Set<string>();
    for (const p of packagings) {
      if (p.batchId === productBatchId) continue; // its own packaging run, not "cross"
      const breakdown: any[] = Array.isArray(p.bulkBreakdown) ? p.bulkBreakdown : [];
      if (breakdown.some((b) => b.productBatchId === productBatchId)) {
        affected.add(p.batchId);
      }
    }
    return Array.from(affected);
  }

  // Single formula for "how much of this batch's own approved output is
  // still sitting in the warehouse right now, in this batch's own unit" —
  // shared by getBatchQuantities and locateDistribution so the two can never
  // disagree. See the long comment at its call site in getBatchQuantities
  // for why this can't be a sum of InventoryBatch.currentQty.
  private static resolveAvailableQty(approvedQty: number, wastedQty: number, distributedQty: number, returnedQty: number): number {
    return Math.max(0, approvedQty - wastedQty - distributedQty + returnedQty);
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

    // "Left the lot to somewhere a recall can act on" — genuine outbound
    // distribution only (sale, dispatch, franchise transfer), never waste/
    // spoilage or internal bin/adjustment churn. Previously this summed
    // initialQty - currentQty for ANY reason the quantity dropped, which
    // counted waste write-offs as "distributed" and made them eligible for
    // Collect Returned Stock — collecting a "return" on destroyed stock then
    // added that quantity back into currentQty with no physical stock behind
    // it. Computed straight from the real movement rows so it always agrees
    // with locateDistribution()'s breakdown below.
    const inventoryBatchIds = inventoryBatches.map((b) => b.id);
    const outboundMovements = inventoryBatchIds.length
      ? await prisma.stockMovement.findMany({
          where: { batchId: { in: inventoryBatchIds }, quantity: { lt: 0 }, referenceType: { in: GENUINE_DISTRIBUTION_REFERENCE_TYPES } },
        })
      : [];
    const distributedQty = outboundMovements.reduce((s, m) => s + Math.abs(m.quantity), 0);

    // Destroyed/written-off warehouse stock (damage, spoilage) — tracked
    // separately from distributedQty precisely so it's never treated as
    // something a recall can ask to be "returned." Reconciles as:
    // approvedQty - wastedQty - distributedQty (+ returnedQty already
    // credited back) = availableQty.
    const wasteMovements = inventoryBatchIds.length
      ? await prisma.stockMovement.findMany({
          where: { batchId: { in: inventoryBatchIds }, quantity: { lt: 0 }, referenceType: 'WASTE' },
        })
      : [];
    const wastedQty = wasteMovements.reduce((s, m) => s + Math.abs(m.quantity), 0);

    const returnedQty = (await prisma.batchRecall.findUnique({ where: { productBatchId }, select: { returnedQty: true } }))?.returnedQty || 0;
    // Deliberately NOT a sum of InventoryBatch.currentQty across this
    // batch's lots (that was the old implementation, and the root cause of
    // a batch showing "Available" figures larger than its own approvedQty —
    // e.g. 96 KG available against a 48 KG approved batch). The bulk pool is
    // shared across every ProductBatch of the same recipe with unscoped FIFO
    // (see findCrossBatchAffectedIds), so this batch's own bulk
    // InventoryBatch row can sit fully untouched — because packaging drew an
    // older/cheaper lot belonging to a DIFFERENT batch instead — while a
    // separate retail InventoryBatch (a different unit: packets, not KG) is
    // also created and tagged with this same productBatchId once packaging
    // confirms. Summing both counted the same approved output twice, in two
    // different units. This batch's own approvedQty, minus what's verifiably
    // left the building (wastedQty, distributedQty) plus what's verifiably
    // come back (returnedQty), is the only number that can never exceed what
    // this batch actually produced, regardless of which physical pooled lot
    // any of it moved through.
    const availableQty = this.resolveAvailableQty(batch.approvedQty || 0, wastedQty, distributedQty, returnedQty);

    const crossBatchAffectedIds = await this.findCrossBatchAffectedIds(prisma, productBatchId, batch.production?.recipeId);
    const crossBatchAffected = crossBatchAffectedIds.length
      ? await prisma.productBatch.findMany({
          where: { id: { in: crossBatchAffectedIds } },
          select: { id: true, batchCode: true, qcStatus: true, approvedQty: true, packagedQty: true },
        })
      : [];

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
      wastedQty,
      inventoryBatches,
      // Other ProductBatches whose packaged output may contain this batch's
      // material via the shared bulk pool (see findCrossBatchAffectedIds).
      // Not folded into the figures above — reported separately so it's
      // never silently conflated with this batch's own direct stock.
      crossBatchAffected,
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
        // product is legitimately null for a recipe with no linked Product
        // (see approveProduction) — the recipe name is still the batch's
        // real, canonical product reference.
        productName: quantities.batch.product?.name || quantities.batch.production?.recipe?.name,
        qcStatus: quantities.batch.qcStatus,
        unit: quantities.unit,
        producedQty: quantities.producedQty,
        approvedQty: quantities.approvedQty,
        rejectedQty: quantities.rejectedQty,
        packagedQty: quantities.packagedQty,
        cartonedQty: quantities.cartonedQty,
        availableQty: quantities.availableQty,
        distributedQty: quantities.distributedQty,
        wastedQty: quantities.wastedQty,
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

  // RCL-<year>-<seq>, allocated atomically inside the initiating transaction.
  private static async nextRecallNumber(tx: any): Promise<string> {
    const year = new Date().getFullYear();
    const seq = await tx.numberSequence.upsert({
      where: { key: `RECALL_${year}` },
      create: { key: `RECALL_${year}`, value: 1 },
      update: { value: { increment: 1 } },
    });
    return `RCL-${year}-${String(seq.value).padStart(4, '0')}`;
  }

  static async initiateRecall(productBatchId: string, data: {
    reason: string;
    reasonNotes?: string;
    severity?: string;
    description?: string;
    userId?: string;
  }) {
    if (!VALID_REASONS.includes(data.reason)) {
      throw new Error(`Invalid recall reason. Must be one of: ${VALID_REASONS.join(', ')}`);
    }
    if (data.severity !== undefined && !RECALL_SEVERITIES.includes(data.severity)) {
      throw new Error(`Invalid severity. Must be one of: ${RECALL_SEVERITIES.join(', ')}`);
    }
    // The description doubles as the reason notes for "Other".
    const notes = (data.description ?? data.reasonNotes ?? '').trim() || undefined;
    if (data.reason === 'Other' && !notes) {
      throw new Error('Notes are required when recall reason is "Other".');
    }
    data = { ...data, reasonNotes: notes };

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
      //
      // Locked (FOR UPDATE), not a plain findMany: depleteBatchesFIFO's own
      // read of these same rows is now FOR UPDATE too (see its comment), so
      // whichever of a concurrent sale or this recall reaches the row first
      // wins the lock and the other waits. Without locking here as well,
      // this read could return a STALE pre-sale currentQty (e.g. still 20)
      // even though a concurrent sale is mid-flight and about to commit 0 —
      // this recall's own updateMany would still correctly end up flipping
      // status to BLOCKED (Postgres blocks that write until the sale
      // commits, then re-checks status='APPROVED', which still holds), but
      // blockedQty computed from the stale read would over-report a
      // quantity that was actually already sold, corrupting the audit
      // trail and downstream reconciliation even though the stock itself
      // stayed correct.
      const inventoryBatches: Array<{ id: string; status: string; currentQty: number }> = await tx.$queryRaw(
        Prisma.sql`SELECT id, status, "currentQty" FROM "InventoryBatch" WHERE "productBatchId" = ${productBatchId} FOR UPDATE`
      );
      const blockable = inventoryBatches.filter((b) => b.status === 'APPROVED');
      if (blockable.length) {
        await tx.inventoryBatch.updateMany({
          where: { id: { in: blockable.map((b) => b.id) } },
          data: { status: 'BLOCKED' },
        });
      }
      const blockedQty = blockable.reduce((s, b) => s + b.currentQty, 0);

      // This batch's bulk output can have been blended into OTHER batches'
      // packaging runs via the shared bulk pool (see
      // findCrossBatchAffectedIds) — their retail stock is tagged with THAT
      // other batch's productBatchId, so it's invisible to the direct
      // lookup above. Block it too, or a recall could quarantine this
      // batch's own lots while contaminated material sold under a
      // different batch's label stays on shelves.
      const crossBatchAffectedIds = await this.findCrossBatchAffectedIds(tx, productBatchId, batch.production?.recipeId);
      let crossBlockedQty = 0;
      if (crossBatchAffectedIds.length) {
        // Same locking rationale as the direct lookup above.
        const crossInventoryBatches: Array<{ id: string; currentQty: number }> = await tx.$queryRaw(
          Prisma.sql`SELECT id, "currentQty" FROM "InventoryBatch" WHERE "productBatchId" IN (${Prisma.join(crossBatchAffectedIds)}) AND status = 'APPROVED' FOR UPDATE`
        );
        if (crossInventoryBatches.length) {
          await tx.inventoryBatch.updateMany({
            where: { id: { in: crossInventoryBatches.map((b: any) => b.id) } },
            data: { status: 'BLOCKED' },
          });
          crossBlockedQty = crossInventoryBatches.reduce((s: number, b: any) => s + b.currentQty, 0);
        }
      }

      // Explicit about what this figure is (and isn't): only the stock still
      // sitting in warehouse right now. Anything already dispatched before the
      // recall started isn't in currentQty any more — that portion shows up
      // separately as "distributed" once locateDistribution runs, and the two
      // numbers are deliberately not meant to be summed with this one.
      const message = blockedQty > 0 || crossBlockedQty > 0
        ? `${blockedQty} ${unit} of remaining warehouse stock quarantined directly (blocked from sale/dispatch)`
          + (crossBlockedQty > 0
            ? `, plus ${crossBlockedQty} ${unit} quarantined from ${crossBatchAffectedIds.length} other batch(es) whose packaging drew on this batch's shared bulk pool.`
            : '.')
          + ' Any quantity already dispatched before this recall is tracked separately as distributed.'
        : 'No warehouse stock remained for this batch — nothing available to quarantine.';

      const recallNumber = await this.nextRecallNumber(tx);

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'RECALL_INITIATED',
          status: 'SUCCESS',
          actor: data.userId || 'system',
          affectedQty: blockedQty + crossBlockedQty,
          details: {
            recallNumber,
            severity: data.severity || null,
            description: data.reasonNotes || null,
            reason: data.reason,
            reasonNotes: data.reasonNotes || null,
            blockedInventoryBatchIds: blockable.map((b) => b.id),
            crossBatchAffectedProductBatchIds: crossBatchAffectedIds,
            crossBlockedQty,
            message,
          },
        },
      });

      return { ...recall, recallNumber, severity: data.severity || null };
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

      // Only outbound movements that trace back to this batch's own
      // InventoryBatch lot(s) — real StockMovement rows, never fabricated —
      // AND that represent genuine outbound distribution (sale, dispatch,
      // franchise transfer), never waste/spoilage write-offs or internal
      // bin/adjustment churn. Previously this pulled every negative
      // movement regardless of cause, which listed waste write-offs as an
      // "affected location" alongside real destinations and let a pure
      // internal bin reassignment (which nets to zero) show up as 50 KG
      // "distributed" to a phantom location.
      // Note: recordMovement() only stamps a batchId when a movement drew
      // from exactly one lot (see inventory.service.ts), so a sale that
      // spanned multiple lots of this same batch is not individually
      // attributable here even though it is included in distributedQty below.
      const movements = inventoryBatchIds.length
        ? await tx.stockMovement.findMany({
            where: { batchId: { in: inventoryBatchIds }, quantity: { lt: 0 }, referenceType: { in: GENUINE_DISTRIBUTION_REFERENCE_TYPES } },
            include: { warehouse: true },
          })
        : [];
      // Recomputed from the same filtered movements that build
      // affectedLocations below, so the two can never disagree — this now
      // matches getBatchQuantities()'s definition of "distributed" exactly.
      const distributedQty = movements.reduce((s, m) => s + Math.abs(m.quantity), 0);

      // Same formula as getBatchQuantities — not a sum of
      // InventoryBatch.currentQty (see resolveAvailableQty / the long
      // comment in getBatchQuantities for why that double-counted pooled
      // bulk vs. packaged-retail lots under the same productBatchId).
      const wasteMovements = inventoryBatchIds.length
        ? await tx.stockMovement.findMany({
            where: { batchId: { in: inventoryBatchIds }, quantity: { lt: 0 }, referenceType: 'WASTE' },
          })
        : [];
      const wastedQty = wasteMovements.reduce((s, m) => s + Math.abs(m.quantity), 0);
      const availableWarehouseQty = this.resolveAvailableQty(batch?.approvedQty || 0, wastedQty, distributedQty, recall.returnedQty || 0);

      // This batch's bulk output can have been blended into OTHER batches'
      // packaging runs via the shared bulk pool (see
      // findCrossBatchAffectedIds) — that stock is tagged with the OTHER
      // batch's productBatchId and dispatched under its own StockMovement
      // rows, so it's entirely invisible to the direct query above. Trace
      // it separately so the recall report doesn't understate where
      // potentially-affected material actually went.
      const crossBatchAffectedIds = await this.findCrossBatchAffectedIds(tx, productBatchId, batch?.production?.recipeId);
      const crossInventoryBatches = crossBatchAffectedIds.length
        ? await tx.inventoryBatch.findMany({ where: { productBatchId: { in: crossBatchAffectedIds } } })
        : [];
      const crossInventoryBatchIds = crossInventoryBatches.map((b: any) => b.id);
      const crossMovements = crossInventoryBatchIds.length
        ? await tx.stockMovement.findMany({
            where: { batchId: { in: crossInventoryBatchIds }, quantity: { lt: 0 }, referenceType: { in: GENUINE_DISTRIBUTION_REFERENCE_TYPES } },
            include: { warehouse: true },
          })
        : [];
      const crossDistributedQty = crossMovements.reduce((s: number, m: any) => s + Math.abs(m.quantity), 0);

      const allMovements = [...movements, ...crossMovements];
      const orderIds = Array.from(new Set(allMovements.filter((m) => m.referenceType === 'ORDER').map((m) => m.referenceId).filter((id): id is string => !!id)));
      const franchiseOrderIds = Array.from(new Set(allMovements.filter((m) => m.referenceType === 'FRANCHISE_ORDER').map((m) => m.referenceId).filter((id): id is string => !!id)));

      const orders = orderIds.length
        ? await tx.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, invoiceNum: true, franchise: { select: { name: true } } } })
        : [];
      const franchiseOrders = franchiseOrderIds.length
        ? await tx.franchiseOrder.findMany({ where: { id: { in: franchiseOrderIds } }, select: { id: true, orderNumber: true, franchiseId: true, franchise: { select: { name: true } } } })
        : [];

      const crossMovementIds = new Set(crossMovements.map((m: any) => m.id));
      const locations = new Map<string, { type: string; label: string; qty: number; crossBatch: boolean }>();
      for (const m of allMovements) {
        const isCross = crossMovementIds.has(m.id);
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
        // Cross-batch and direct dispatches to the same nominal location are
        // kept as separate rows (never merged into one qty) — the whole
        // point is to not understate or blur which portion is only
        // suspected via the shared bulk pool versus this batch's own lot.
        if (isCross) key = `CROSS:${key}`;

        const existing = locations.get(key) || { type, label: isCross ? `(Cross-batch pool) ${label}` : label, qty: 0, crossBatch: isCross };
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
          + (crossDistributedQty > 0
            ? ` An additional ${crossDistributedQty} ${unit} was dispatched from ${crossBatchAffectedIds.length} other batch(es) whose packaging drew on this batch's shared bulk pool — treat as suspect pending further review.`
            : '')
        : 'No stock had left the warehouse for this batch before the recall — nothing to trace.';

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'DISTRIBUTION_LOCATED',
          status: 'SUCCESS',
          actor: userId || 'system',
          affectedQty: distributedQty + crossDistributedQty,
          details: { affectedLocations, availableWarehouseQty, crossDistributedQty, crossBatchAffectedProductBatchIds: crossBatchAffectedIds, message } as any,
        },
      });

      return { affectedLocations, distributedQty, crossDistributedQty, availableWarehouseQty, message };
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

      // Locked (FOR UPDATE) — same rationale as initiateRecall: avoids
      // reporting a stale pre-sale currentQty if a sale is concurrently
      // racing this same row.
      const inventoryBatches: Array<{ id: string; status: string; currentQty: number }> = await tx.$queryRaw(
        Prisma.sql`SELECT id, status, "currentQty" FROM "InventoryBatch" WHERE "productBatchId" = ${productBatchId} FOR UPDATE`
      );
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
        productName: quantities.batch.product?.name || quantities.batch.production?.recipe?.name,
        productionDate: quantities.batch.production?.startTime || quantities.batch.mfgDate || quantities.batch.createdAt,
        qcStatus: quantities.batch.qcStatus,
        unit: quantities.unit,
        producedQty: quantities.producedQty,
        approvedQty: quantities.approvedQty,
        rejectedQty: quantities.rejectedQty,
        wastedQty: quantities.wastedQty,
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

  static async collectReturn(
    productBatchId: string,
    returnedQty: number,
    userId?: string,
    opts?: { inventoryBatchId?: string; warehouseId?: string; note?: string },
  ) {
    // Per-SKU recovery (Recall Details screen): credited to its own
    // quarantined lot for the SKU that actually came back.
    if (opts?.inventoryBatchId) {
      return this.collectReturnForLot(productBatchId, { inventoryBatchId: opts.inventoryBatchId, quantity: returnedQty, warehouseId: opts.warehouseId, note: opts.note }, userId);
    }
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

  // Closing never happens just because stock was blocked: it needs a
  // reconciliation that still matches the current stock picture, nothing
  // outstanding, and a closure note. Quarantined stock stays quarantined.
  static async completeRecall(productBatchId: string, userId?: string, closureNote?: string) {
    const note = (closureNote || '').trim();
    if (note.length < 10) throw new Error('A closure note is required (at least 10 characters).');
    return prisma.$transaction(async (tx) => {
      const recall = await this.activeRecallTx(tx, productBatchId);
      const trace = await this.traceBatch(tx, productBatchId);
      const events = await tx.batchRecallEvent.findMany({ where: { recallId: recall.id }, orderBy: { createdAt: 'asc' } });
      const summary = this.summarise(recall, events, trace!.skus);
      if (!summary.reconciliation) throw new Error('Reconcile the recall (recovered, disposed, unavailable and outstanding quantities) before closing it.');
      if (!summary.reconciliation.current) throw new Error('Stock has changed since the last reconciliation. Reconcile again before closing.');
      if ((summary.reconciliation.outstandingTotal || 0) > 0) {
        throw new Error(`Cannot close — ${summary.reconciliation.outstandingTotal} unit(s) are still outstanding in the reconciliation.`);
      }

      const updated = await tx.batchRecall.update({
        where: { productBatchId },
        data: { status: 'COMPLETED', step: 'COMPLETED', completedAt: new Date() },
      });

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id, event: 'RECALL_COMPLETED', status: 'SUCCESS', actor: userId || 'system',
          details: { note, recallNumber: summary.recallNumber, reconciledAt: summary.reconciliation.at, quarantinedRemaining: trace!.skus.map(s => ({ sku: s.sku, unit: s.unit, qty: s.quarantinedQty })) } as any,
        },
      });

      return updated;
    });
  }

  // Cancelling releases blocked stock back to sale, so it is a separately
  // authorised decision (SUPER_ADMIN route) that must be documented.
  static async cancelRecall(productBatchId: string, note: string | undefined, userId?: string) {
    if ((note || '').trim().length < 10) throw new Error('A documented reason (at least 10 characters) is required to cancel a recall and release its stock.');
    return prisma.$transaction(async (tx) => {
      const recall = await this.activeRecallTx(tx, productBatchId);

      // Release whatever this recall blocked back to sellable stock. Lots
      // that received returned stock (status RETURNED) are left as-is —
      // cancelling a recall shouldn't silently make physically-quarantined
      // returned goods sellable again.
      const released = await tx.inventoryBatch.updateMany({
        where: { productBatchId, status: 'BLOCKED' },
        data: { status: 'APPROVED' },
      });

      // Initiation also blocked lots of OTHER batches whose packaging drew on
      // this batch's bulk (see findCrossBatchAffectedIds). Release those too —
      // unless that batch is itself under its own recall.
      const batch = await tx.productBatch.findUnique({ where: { id: productBatchId }, include: { production: true } });
      const crossIds = await this.findCrossBatchAffectedIds(tx, productBatchId, batch?.production?.recipeId);
      let crossReleased = 0;
      if (crossIds.length) {
        const ownRecalls = await tx.batchRecall.findMany({
          where: { productBatchId: { in: crossIds }, status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
          select: { productBatchId: true },
        });
        const releasable = crossIds.filter(id => !ownRecalls.some(r => r.productBatchId === id));
        if (releasable.length) {
          crossReleased = (await tx.inventoryBatch.updateMany({
            where: { productBatchId: { in: releasable }, status: 'BLOCKED' },
            data: { status: 'APPROVED' },
          })).count;
        }
      }

      const updated = await tx.batchRecall.update({
        where: { productBatchId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id, event: 'RECALL_CANCELLED', status: 'SUCCESS', actor: userId || 'system',
          details: { note: note!.trim(), releasedLots: released.count, crossReleasedLots: crossReleased, message: `Recall cancelled — ${released.count + crossReleased} blocked lot(s) released to sale. Returned (quarantined) stock stays quarantined.` } as any,
        },
      });

      return updated;
    });
  }

  // ── Traceability, recovery, disposal, reconciliation ───────────────────
  //
  // Everything below is derived from real rows only: every InventoryBatch lot
  // tagged with this production batch (bulk, every packed SKU, recall-return
  // lots, and lots of other batches that drew on this batch's bulk via the
  // shared pool), and the StockMovement ledger against those lots. Nothing is
  // estimated, and no figure is ever converted between SKUs/units — each SKU
  // is reported in its own stock unit.

  // Per-lot and per-SKU traceability for a production batch (works with or
  // without a recall, so the Initiate screen can preview affected stock).
  static async traceBatch(tx: any, productBatchId: string) {
    const batch = await tx.productBatch.findUnique({
      where: { id: productBatchId },
      include: {
        product: true,
        production: { include: { recipe: true } },
        packagings: { orderBy: { createdAt: 'asc' } },
        recall: true,
      },
    });
    if (!batch) return null;

    const crossBatchIds = await this.findCrossBatchAffectedIds(tx, productBatchId, batch.production?.recipeId);
    const lots = await tx.inventoryBatch.findMany({
      where: { productBatchId: { in: [productBatchId, ...crossBatchIds] } },
      include: {
        inventoryItem: { include: { franchise: { select: { id: true, name: true } } } },
        warehouse: { select: { id: true, name: true } },
        productBatch: { select: { id: true, batchCode: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const lotIds = lots.map((l: any) => l.id);
    const lotIdSet = new Set<string>(lotIds);
    const itemIds = Array.from(new Set<string>(lots.map((l: any) => l.inventoryItemId)));

    // Movements against these lots: single-lot movements carry batchId;
    // multi-lot ones carry a consumptionBreakdown — take only this scope's share.
    const tagged = lotIds.length
      ? await tx.stockMovement.findMany({ where: { batchId: { in: lotIds } }, include: { warehouse: { select: { name: true } } } })
      : [];
    const spanning = itemIds.length
      ? await tx.stockMovement.findMany({
          where: { batchId: null, itemId: { in: itemIds }, consumptionBreakdown: { not: Prisma.JsonNull } },
          include: { warehouse: { select: { name: true } } },
        })
      : [];
    type Mv = { id: string; lotId: string; qty: number; referenceType: string | null; referenceId: string | null; movementType: string; note: string | null; createdAt: Date; createdBy: string | null; warehouseName: string | null };
    const mvs: Mv[] = [];
    for (const m of tagged) {
      mvs.push({ id: m.id, lotId: m.batchId, qty: m.baseQty ?? m.quantity, referenceType: m.referenceType, referenceId: m.referenceId, movementType: m.movementType, note: m.note, createdAt: m.createdAt, createdBy: m.createdBy, warehouseName: m.warehouse?.name || null });
    }
    for (const m of spanning) {
      const parts: any[] = Array.isArray(m.consumptionBreakdown) ? m.consumptionBreakdown : [];
      for (const c of parts) {
        if (!lotIdSet.has(c.batchId)) continue;
        mvs.push({ id: `${m.id}:${c.batchId}`, lotId: c.batchId, qty: -Math.abs(Number(c.qty) || 0), referenceType: m.referenceType, referenceId: m.referenceId, movementType: m.movementType, note: m.note, createdAt: m.createdAt, createdBy: m.createdBy, warehouseName: m.warehouse?.name || null });
      }
    }
    mvs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const recallId: string | null = batch.recall?.id || null;
    const isDistribution = (m: Mv) => m.qty < 0 && GENUINE_DISTRIBUTION_REFERENCE_TYPES.includes(m.referenceType || '');
    const isRecovery = (m: Mv) => m.qty > 0 && m.referenceType === 'RECALL';
    const isDisposal = (m: Mv) => m.qty < 0 && m.referenceType === DISPOSAL_REFERENCE_TYPE && !!recallId && m.referenceId === recallId;
    // A transfer between two lots of this same scope (e.g. HQ -> franchise
    // warehouse) moves stock, it doesn't distribute it out of reach.
    const isInternalTransferIn = (m: Mv) => m.qty > 0 && m.referenceType === 'TRANSFER';
    // Ordinary damage/spoilage write-offs (not recall disposals).
    const isWaste = (m: Mv) => m.qty < 0 && m.referenceType === 'WASTE' && !isDisposal(m);

    // Human-readable destinations for outbound movements.
    const orderIds = Array.from(new Set(mvs.filter(m => isDistribution(m) && m.referenceType === 'ORDER').map(m => m.referenceId).filter(Boolean))) as string[];
    const foIds = Array.from(new Set(mvs.filter(m => isDistribution(m) && m.referenceType === 'FRANCHISE_ORDER').map(m => m.referenceId).filter(Boolean))) as string[];
    const dcIds = Array.from(new Set(mvs.filter(m => isDistribution(m) && m.referenceType === 'DELIVERY_CHALLAN').map(m => m.referenceId).filter(Boolean))) as string[];
    const orders = orderIds.length ? await tx.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, invoiceNum: true, franchise: { select: { name: true } } } }) : [];
    const fos = foIds.length ? await tx.franchiseOrder.findMany({ where: { id: { in: foIds } }, select: { id: true, orderNumber: true, franchise: { select: { name: true } } } }) : [];
    const dcs = dcIds.length ? await tx.deliveryChallan.findMany({ where: { id: { in: dcIds } }, select: { id: true, challanNumber: true } }) : [];
    const destinationOf = (m: Mv): { type: string; label: string } => {
      if (m.referenceType === 'ORDER') {
        const o = orders.find((x: any) => x.id === m.referenceId);
        return { type: 'POS_SALE', label: o ? `POS Sale ${o.invoiceNum} (${o.franchise?.name || 'HQ'})` : 'POS Sale' };
      }
      if (m.referenceType === 'FRANCHISE_ORDER') {
        const fo = fos.find((x: any) => x.id === m.referenceId);
        return { type: 'FRANCHISE_DISPATCH', label: fo ? `Franchise ${fo.franchise?.name} (Order ${fo.orderNumber})` : 'Franchise Dispatch' };
      }
      if (m.referenceType === 'DELIVERY_CHALLAN') {
        const dc = dcs.find((x: any) => x.id === m.referenceId);
        return { type: 'DELIVERY_CHALLAN', label: dc ? `Delivery Challan ${dc.challanNumber}` : 'Delivery Challan' };
      }
      if (m.referenceType === 'TRANSFER') return { type: 'TRANSFER', label: `Stock Transfer${m.warehouseName ? ` from ${m.warehouseName}` : ''}` };
      return { type: m.referenceType || 'OTHER', label: (m.referenceType || 'Other').replace(/_/g, ' ') };
    };

    const isReturnLot = (l: any) => l.status === 'RETURNED' && /(-RETURN$|^RECALL-RETURN-)/.test(l.batchNumber || '');
    const lotRows = lots.map((l: any) => {
      const lm = mvs.filter(m => m.lotId === l.id);
      const sum = (f: (m: Mv) => boolean) => r3(lm.filter(f).reduce((s, m) => s + Math.abs(m.qty), 0));
      const quarantined = l.status === 'BLOCKED' || l.status === 'RETURNED' ? r3(l.currentQty) : 0;
      return {
        id: l.id,
        lotNumber: l.batchNumber || l.lotNumber || null,
        productBatchId: l.productBatchId,
        productBatchCode: l.productBatch?.batchCode || null,
        crossBatch: l.productBatchId !== productBatchId,
        returnLot: isReturnLot(l),
        inventoryItemId: l.inventoryItemId,
        sku: l.inventoryItem?.sku || null,
        name: l.inventoryItem?.name || 'Item',
        unit: l.inventoryItem?.unit || 'PC',
        category: l.inventoryItem?.category || null,
        scope: l.inventoryItem?.franchise ? `Franchise: ${l.inventoryItem.franchise.name}` : 'HQ',
        warehouse: l.warehouse?.name || null,
        status: l.status,
        initialQty: r3(l.initialQty),
        currentQty: r3(l.currentQty),
        quarantinedQty: quarantined,
        sellableQty: l.status === 'APPROVED' ? r3(l.currentQty) : 0,
        distributedQty: sum(isDistribution),
        transferredInQty: sum(isInternalTransferIn),
        recoveredQty: sum(isRecovery),
        disposedQty: sum(isDisposal),
        wastedQty: sum(isWaste),
      };
    });

    // Per SKU (inventory item) — never summed across SKUs/units.
    const skuMap = new Map<string, any>();
    for (const l of lotRows) {
      const s = skuMap.get(l.inventoryItemId) || {
        inventoryItemId: l.inventoryItemId, sku: l.sku, name: l.name, unit: l.unit, category: l.category,
        crossBatch: false, packedQty: 0, distributedQty: 0, recoveredQty: 0, disposedQty: 0, wastedQty: 0,
        quarantinedQty: 0, sellableQty: 0, onHandQty: 0, locations: [] as any[], destinations: [] as any[],
        _transferIn: 0,
      };
      s.crossBatch = s.crossBatch || l.crossBatch;
      if (!l.returnLot) s.packedQty += l.initialQty;
      s.distributedQty += l.distributedQty;
      s._transferIn += l.transferredInQty;
      s.recoveredQty += l.recoveredQty;
      s.disposedQty += l.disposedQty;
      s.wastedQty += l.wastedQty;
      s.quarantinedQty += l.quarantinedQty;
      s.sellableQty += l.sellableQty;
      s.onHandQty += l.currentQty;
      if (l.currentQty > 0 || l.quarantinedQty > 0) {
        s.locations.push({ lotId: l.id, lotNumber: l.lotNumber, scope: l.scope, warehouse: l.warehouse, status: l.status, qty: l.currentQty, returnLot: l.returnLot, crossBatch: l.crossBatch, productBatchCode: l.productBatchCode });
      }
      skuMap.set(l.inventoryItemId, s);
    }
    for (const m of mvs.filter(isDistribution)) {
      const lot = lotRows.find(l => l.id === m.lotId);
      if (!lot) continue;
      const s = skuMap.get(lot.inventoryItemId);
      const d = destinationOf(m);
      const existing = s.destinations.find((x: any) => x.label === d.label);
      if (existing) existing.qty = r3(existing.qty + Math.abs(m.qty));
      else s.destinations.push({ ...d, qty: r3(Math.abs(m.qty)) });
    }
    const skus = Array.from(skuMap.values()).map((s: any) => {
      // Distributed out of reach = outbound minus what landed back in a lot
      // of this same scope via an internal transfer.
      const distributed = r3(Math.max(0, s.distributedQty - s._transferIn));
      const { _transferIn, ...rest } = s;
      return {
        ...rest,
        packedQty: r3(s.packedQty),
        distributedQty: distributed,
        recoveredQty: r3(s.recoveredQty),
        disposedQty: r3(s.disposedQty),
        wastedQty: r3(s.wastedQty),
        quarantinedQty: r3(s.quarantinedQty),
        sellableQty: r3(s.sellableQty),
        onHandQty: r3(s.onHandQty),
        outstandingQty: r3(Math.max(0, distributed - s.recoveredQty)),
      };
    });

    const activity = mvs
      .filter(m => isDistribution(m) || isRecovery(m) || isDisposal(m) || m.referenceType === 'RETURN' || m.movementType === 'SALES_RETURN_IN' || m.movementType === 'RETURN_QUARANTINE_IN')
      .map(m => {
        const lot = lotRows.find(l => l.id === m.lotId);
        const kind = isDistribution(m) ? 'DISTRIBUTED' : isRecovery(m) ? 'RECOVERED' : isDisposal(m) ? 'DISPOSED' : 'RETURNED';
        return {
          id: m.id, at: m.createdAt, kind, qty: r3(Math.abs(m.qty)), unit: lot?.unit, sku: lot?.sku, name: lot?.name,
          reference: kind === 'DISTRIBUTED' ? destinationOf(m).label : (m.note || m.referenceType || ''),
          warehouse: m.warehouseName, by: m.createdBy,
        };
      });

    return { batch, crossBatchIds, lots: lotRows, skus, activity };
  }

  // Fingerprint of the stock picture a reconciliation was made against. A
  // closure is only accepted while the current picture still matches.
  private static snapshotOf(skus: any[]) {
    return skus
      .map(s => [s.inventoryItemId, s.distributedQty, s.recoveredQty, s.disposedQty, s.quarantinedQty].join(':'))
      .sort()
      .join('|');
  }

  private static async userNames(tx: any, ids: (string | null | undefined)[]) {
    const unique = Array.from(new Set(ids.filter((x): x is string => !!x && x !== 'system')));
    if (!unique.length) return {} as Record<string, string>;
    const users = await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
    return Object.fromEntries(users.map((u: any) => [u.id, u.fullName])) as Record<string, string>;
  }

  // Recall number / severity / description from the latest initiation event,
  // the latest reconciliation, and the derived business lifecycle.
  private static summarise(recall: any, events: any[], skus: any[] | null) {
    const initiated = [...events].reverse().find(e => e.event === 'RECALL_INITIATED');
    const sinceInit = events.filter(e => !initiated || e.createdAt >= initiated.createdAt);
    const reconciliation = [...sinceInit].reverse().find(e => e.event === 'RECALL_RECONCILED') || null;
    const reconciliationCurrent = !!reconciliation && !!skus && reconciliation.details?.snapshot === this.snapshotOf(skus);
    let lifecycle: RecallLifecycle;
    if (recall.status === 'COMPLETED') lifecycle = 'CLOSED';
    else if (recall.status === 'CANCELLED') lifecycle = 'CANCELLED';
    else if (recall.step === 'INITIATED') lifecycle = 'INITIATED';
    else lifecycle = reconciliationCurrent ? 'RECONCILED' : 'IN_PROGRESS';
    return {
      recallNumber: initiated?.details?.recallNumber || `RCL-${recall.id.slice(0, 8).toUpperCase()}`,
      severity: initiated?.details?.severity || null,
      description: initiated?.details?.description || recall.reasonNotes || null,
      lifecycle,
      reconciliation: reconciliation ? { at: reconciliation.createdAt, by: reconciliation.actor, current: reconciliationCurrent, ...reconciliation.details } : null,
    };
  }

  // Full Recall Details: batch, per-SKU quantities, locations, activity and
  // audit history. Also used (without a recall) to preview affected stock.
  static async getRecallDetails(productBatchId: string) {
    const trace = await this.traceBatch(prisma, productBatchId);
    if (!trace) return null;
    const { batch } = trace;
    const recall = batch.recall;
    const events = recall
      ? await prisma.batchRecallEvent.findMany({ where: { recallId: recall.id }, orderBy: { createdAt: 'asc' } })
      : [];
    const names = await this.userNames(prisma, [recall?.initiatedBy, ...events.map(e => e.actor), ...trace.activity.map(a => a.by)]);
    const attachments = recall
      ? await prisma.attachment.findMany({
          where: { entityType: 'BATCH_RECALL', entityId: recall.id },
          select: { id: true, fileName: true, mimeType: true, size: true, kind: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    return {
      batch: {
        id: batch.id,
        batchCode: batch.batchCode,
        productName: batch.product?.name || batch.production?.recipe?.name,
        recipeName: batch.production?.recipe?.name || null,
        unit: batch.production?.recipe?.yieldUnit || 'KG',
        mfgDate: batch.mfgDate || batch.production?.startTime || batch.createdAt,
        expiryDate: batch.expiryDate || batch.production?.expiryDate || null,
        producedQty: batch.quantity || 0,
        releasedQty: batch.approvedQty || 0,
        rejectedQty: batch.rejectionQty || 0,
        packagedQty: batch.packagedQty || 0,
        qcStatus: batch.qcStatus,
        packagingStatus: batch.packagingStatus,
      },
      packagings: batch.packagings
        .filter((p: any) => p.status === 'CONFIRMED')
        .map((p: any) => ({ id: p.id, packetSize: p.packetSize, goodQty: p.goodQty ?? 0, damagedQty: p.damagedQty ?? 0, totalWeight: p.totalWeight, confirmedAt: p.confirmedAt })),
      skus: trace.skus,
      lots: trace.lots,
      activity: trace.activity.map(a => ({ ...a, by: a.by ? names[a.by] || a.by : null })),
      crossBatchCount: trace.crossBatchIds.length,
      recall: recall
        ? {
            id: recall.id,
            status: recall.status,
            step: recall.step,
            reason: recall.reason,
            initiatedAt: recall.initiatedAt,
            initiatedBy: recall.initiatedBy ? names[recall.initiatedBy] || recall.initiatedBy : null,
            completedAt: recall.completedAt,
            cancelledAt: recall.cancelledAt,
            ...this.summarise(recall, events, trace.skus),
          }
        : null,
      events: events.map(e => ({ ...e, actorName: e.actor ? names[e.actor] || e.actor : null })),
      attachments,
    };
  }

  // Active Recalls / Recall History list.
  static async listRecalls() {
    const recalls = await prisma.batchRecall.findMany({
      include: {
        productBatch: { include: { product: true, production: { include: { recipe: true } } } },
        events: { where: { event: { in: ['RECALL_INITIATED', 'RECALL_RECONCILED'] } }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { initiatedAt: 'desc' },
    });
    const quarantine = await prisma.inventoryBatch.findMany({
      where: { productBatchId: { in: recalls.map(r => r.productBatchId) }, status: { in: ['BLOCKED', 'RETURNED'] }, currentQty: { gt: 0 } },
      select: { productBatchId: true, currentQty: true, inventoryItem: { select: { unit: true } } },
    });
    return recalls.map(r => {
      const byUnit: Record<string, number> = {};
      for (const q of quarantine.filter(x => x.productBatchId === r.productBatchId)) {
        const u = q.inventoryItem?.unit || 'PC';
        byUnit[u] = r3((byUnit[u] || 0) + q.currentQty);
      }
      // Cheap list view: no per-SKU snapshot, so a reconciled recall shows as
      // IN_PROGRESS here; the details endpoint verifies RECONCILED properly.
      const s = this.summarise(r, r.events, null);
      return {
        id: r.id,
        productBatchId: r.productBatchId,
        batchCode: r.productBatch.batchCode,
        productName: r.productBatch.product?.name || r.productBatch.production?.recipe?.name,
        status: r.status,
        lifecycle: s.lifecycle,
        recallNumber: s.recallNumber,
        severity: s.severity,
        reason: r.reason,
        initiatedAt: r.initiatedAt,
        completedAt: r.completedAt,
        cancelledAt: r.cancelledAt,
        quarantinedByUnit: byUnit,
      };
    });
  }

  // Quarantined (BLOCKED/RETURNED) quantity per inventory item, for Stock Hub.
  static async quarantineSummary() {
    const lots = await prisma.inventoryBatch.findMany({
      where: { status: { in: ['BLOCKED', 'RETURNED'] }, currentQty: { gt: 0 } },
      select: { inventoryItemId: true, currentQty: true, inventoryItem: { select: { sku: true, name: true, unit: true, franchiseId: true } } },
    });
    const map = new Map<string, any>();
    for (const l of lots) {
      const e = map.get(l.inventoryItemId) || { inventoryItemId: l.inventoryItemId, sku: l.inventoryItem?.sku, name: l.inventoryItem?.name, unit: l.inventoryItem?.unit, franchiseId: l.inventoryItem?.franchiseId ?? null, quarantinedQty: 0 };
      e.quarantinedQty = r3(e.quarantinedQty + l.currentQty);
      map.set(l.inventoryItemId, e);
    }
    return Array.from(map.values());
  }

  private static async activeRecallTx(tx: any, productBatchId: string) {
    // Row lock: every recall mutation on this batch is serialised.
    await tx.$queryRaw`SELECT id FROM "BatchRecall" WHERE "productBatchId" = ${productBatchId} FOR UPDATE`;
    const recall = await tx.batchRecall.findUnique({ where: { productBatchId } });
    if (!recall || recall.status !== 'IN_PROGRESS') throw new Error('No active recall in progress for this batch.');
    return recall;
  }

  // Records recovered stock for ONE SKU: the units physically come back as
  // their own RETURNED (quarantined, never sellable) lot through the same
  // path organic recall returns already use. Capped per SKU at what was
  // distributed and not yet recovered.
  private static async collectReturnForLot(productBatchId: string, data: { inventoryBatchId: string; quantity: number; warehouseId?: string; note?: string }, userId?: string) {
    const qty = Number(data.quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Recovered quantity must be greater than 0.');
    return prisma.$transaction(async (tx) => {
      const recall = await this.activeRecallTx(tx, productBatchId);
      if (recall.step === 'INITIATED') throw new Error('Locate distribution before recording recovered stock.');
      const trace = await this.traceBatch(tx, productBatchId);
      const lot = trace!.lots.find(l => l.id === data.inventoryBatchId);
      if (!lot) throw new Error('That stock lot is not part of this recall.');
      const sku = trace!.skus.find(s => s.inventoryItemId === lot.inventoryItemId)!;
      if (qty > sku.outstandingQty + 0.0001) {
        throw new Error(`Only ${sku.outstandingQty} ${sku.unit} of ${sku.name} is distributed and not yet recovered.`);
      }
      await this.recordRecallAffectedReturn(tx, {
        recallId: recall.id,
        productBatchId: lot.productBatchId,
        inventoryItemId: lot.inventoryItemId,
        quantity: qty,
        warehouseId: data.warehouseId || null,
        userId,
        source: 'RECALL_RECOVERY',
        sourceId: recall.id,
        note: data.note?.trim() || `Recovered ${qty} ${sku.unit} of ${sku.name} for recall`,
      });
      if (recall.step === 'REPORT_GENERATED') {
        await tx.batchRecall.update({ where: { id: recall.id }, data: { step: 'RETURN_COLLECTED' } });
      }
      const after = await this.traceBatch(tx, productBatchId);
      return { sku: after!.skus.find(s => s.inventoryItemId === lot.inventoryItemId) };
    });
  }

  // Authorised disposal of QUARANTINED stock only (destroyed, not sellable).
  // Never automatic. Deducts the lot and the item's stock once, logs a
  // WASTE_OUT movement referencing the recall and a waste entry at lot cost.
  static async disposeStock(productBatchId: string, data: { inventoryBatchId: string; quantity: number; note: string }, userId?: string) {
    const qty = Number(data.quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Disposed quantity must be greater than 0.');
    const note = (data.note || '').trim();
    if (note.length < 5) throw new Error('Describe how the stock was disposed (at least 5 characters).');

    return prisma.$transaction(async (tx) => {
      const recall = await this.activeRecallTx(tx, productBatchId);
      const trace = await this.traceBatch(tx, productBatchId);
      const scope = trace!.lots.find(l => l.id === data.inventoryBatchId);
      if (!scope) throw new Error('That stock lot is not part of this recall.');

      const [lot]: Array<{ id: string; status: string; currentQty: number; inventoryItemId: string; warehouseId: string | null; unitCost: number | null }> = await tx.$queryRaw(
        Prisma.sql`SELECT id, status, "currentQty", "inventoryItemId", "warehouseId", "unitCost" FROM "InventoryBatch" WHERE id = ${data.inventoryBatchId} FOR UPDATE`
      );
      if (lot.status !== 'BLOCKED' && lot.status !== 'RETURNED') throw new Error('Only quarantined (blocked or returned) recall stock can be disposed.');
      if (qty > lot.currentQty + 0.0001) throw new Error(`Only ${r3(lot.currentQty)} ${scope.unit} is quarantined in this lot.`);

      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: lot.inventoryItemId } });
      const unitCost = lot.unitCost ?? item.costPrice ?? 0;

      await tx.inventoryBatch.update({ where: { id: lot.id }, data: { currentQty: { decrement: qty } } });
      await tx.inventoryItem.update({ where: { id: lot.inventoryItemId }, data: { currentStock: { decrement: qty } } });
      await tx.stockMovement.create({
        data: {
          itemId: lot.inventoryItemId,
          movementType: 'WASTE_OUT',
          quantity: -qty,
          baseQty: -qty,
          referenceType: DISPOSAL_REFERENCE_TYPE,
          referenceId: recall.id,
          batchId: lot.id,
          unitCost,
          note: `Recall disposal: ${note}`,
          createdBy: userId,
          warehouseId: lot.warehouseId,
        },
      });
      await tx.wasteEntry.create({
        data: {
          inventoryItemId: lot.inventoryItemId,
          franchiseId: item.franchiseId,
          warehouseId: lot.warehouseId || undefined,
          quantity: qty,
          reason: 'RECALL_DISPOSAL',
          note,
          costAtTime: qty * unitCost,
        },
      });
      await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'STOCK_DISPOSED',
          status: 'SUCCESS',
          actor: userId || 'system',
          affectedQty: qty,
          details: { inventoryBatchId: lot.id, inventoryItemId: lot.inventoryItemId, sku: scope.sku, unit: scope.unit, note, message: `Disposed ${qty} ${scope.unit} of ${scope.name}` } as any,
        },
      });
      return { disposedQty: qty, remainingInLot: r3(lot.currentQty - qty) };
    });
  }

  // Documented reconciliation, required before closure. Per SKU the user
  // states how much distributed stock is unavailable (sold and consumed, not
  // recoverable); outstanding = distributed − recovered − unavailable. The
  // stock picture it was made against is fingerprinted, so any later recovery
  // or disposal makes it stale and closure demands a fresh reconciliation.
  static async reconcileRecall(productBatchId: string, data: { lines?: Array<{ inventoryItemId: string; unavailableQty: number }>; notes: string }, userId?: string) {
    const notes = (data.notes || '').trim();
    if (notes.length < 10) throw new Error('Reconciliation notes are required (at least 10 characters).');
    return prisma.$transaction(async (tx) => {
      const recall = await this.activeRecallTx(tx, productBatchId);
      if (recall.step === 'INITIATED') throw new Error('Locate distribution before reconciling the recall.');
      const trace = await this.traceBatch(tx, productBatchId);
      const lines = trace!.skus.map(s => {
        const input = data.lines?.find(l => l.inventoryItemId === s.inventoryItemId);
        const unavailable = r3(Number(input?.unavailableQty ?? 0));
        if (!Number.isFinite(unavailable) || unavailable < 0) throw new Error(`${s.name}: unavailable quantity cannot be negative.`);
        if (unavailable > s.outstandingQty + 0.0001) {
          throw new Error(`${s.name}: unavailable (${unavailable}) cannot exceed distributed-but-unrecovered stock (${s.outstandingQty} ${s.unit}).`);
        }
        return {
          inventoryItemId: s.inventoryItemId, sku: s.sku, name: s.name, unit: s.unit,
          distributedQty: s.distributedQty, recoveredQty: s.recoveredQty, disposedQty: s.disposedQty,
          quarantinedQty: s.quarantinedQty, unavailableQty: unavailable,
          outstandingQty: r3(Math.max(0, s.outstandingQty - unavailable)),
        };
      });
      const outstandingTotal = r3(lines.reduce((t, l) => t + l.outstandingQty, 0));
      const event = await tx.batchRecallEvent.create({
        data: {
          recallId: recall.id,
          event: 'RECALL_RECONCILED',
          status: 'SUCCESS',
          actor: userId || 'system',
          details: { lines, notes, outstandingTotal, snapshot: this.snapshotOf(trace!.skus), message: outstandingTotal > 0 ? `Reconciled — ${outstandingTotal} still outstanding` : 'Reconciled — nothing outstanding' } as any,
        },
      });
      return { reconciliationId: event.id, lines, outstandingTotal, readyToClose: outstandingTotal === 0 };
    });
  }

  // Given the reference a specific sale/dispatch line item was recorded
  // under (e.g. referenceType 'ORDER' + the POS Order id), determines
  // whether ANY InventoryBatch lot it actually drew from — via either a
  // single unambiguous batchId or a multi-lot consumptionBreakdown (see the
  // StockMovement field comment) — traces back to a ProductBatch under an
  // active or completed recall. Used by return processing to force a return
  // into quarantine regardless of the condition an operator submits: per
  // the business rule, ANY recalled contribution taints the whole retail
  // unit sold (bulk pooling blends material, it doesn't separate it), so
  // this deliberately does not try to proportionally split a return between
  // recalled and non-recalled sources.
  //
  // Returns null when no recall involvement is found — including when the
  // original movement predates consumptionBreakdown and has no single
  // batchId (an old multi-lot sale with no per-lot record at all). That is
  // a real, narrower gap than "no protection at all": it only affects
  // historical multi-lot sales made before this field existed, not new
  // ones, and not any single-lot sale regardless of age.
  // Shared by findRecallForSoldItem and resolveSingleSourceProductBatchId:
  // every distinct ProductBatch a given sale/dispatch reference's outbound
  // movement(s) for one item can be traced back to, via either a single
  // unambiguous batchId or a multi-lot consumptionBreakdown.
  private static async resolveSourceProductBatchIds(tx: any, params: { referenceType: string; referenceId: string; inventoryItemId: string }): Promise<string[]> {
    const movements = await tx.stockMovement.findMany({
      where: {
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        itemId: params.inventoryItemId,
        quantity: { lt: 0 },
      },
      select: { batchId: true, consumptionBreakdown: true },
    });
    if (!movements.length) return [];

    const candidateProductBatchIds = new Set<string>();
    const batchIdsToResolve = movements.map((m: any) => m.batchId).filter((id: any): id is string => !!id);
    if (batchIdsToResolve.length) {
      const lots = await tx.inventoryBatch.findMany({
        where: { id: { in: batchIdsToResolve } },
        select: { productBatchId: true },
      });
      for (const lot of lots) if (lot.productBatchId) candidateProductBatchIds.add(lot.productBatchId);
    }
    for (const m of movements) {
      const breakdown: any[] = Array.isArray(m.consumptionBreakdown) ? m.consumptionBreakdown : [];
      for (const c of breakdown) if (c.productBatchId) candidateProductBatchIds.add(c.productBatchId);
    }
    return Array.from(candidateProductBatchIds);
  }

  // Used when crediting an ordinary (non-recalled) "GOOD" return: if the
  // originating sale traces back to EXACTLY ONE ProductBatch, that id is
  // safe to tag the restocked InventoryBatch with, so that a recall
  // declared LATER on that batch can still find and block it — closing the
  // gap where a plain currentStock-only restock (no batch identity at all)
  // would otherwise be permanently invisible to any future recall. Returns
  // null when the source is ambiguous (multiple distinct batches) or
  // unknown (no traceable movement) — callers fall back to the existing
  // untracked restock behavior in that case, unchanged.
  static async resolveSingleSourceProductBatchId(tx: any, params: { referenceType: string; referenceId: string; inventoryItemId: string }): Promise<string | null> {
    const ids = await this.resolveSourceProductBatchIds(tx, params);
    return ids.length === 1 ? ids[0] : null;
  }

  static async findRecallForSoldItem(tx: any, params: { referenceType: string; referenceId: string; inventoryItemId: string }): Promise<{ recallId: string; productBatchId: string; allRecalledProductBatchIds: string[] } | null> {
    const candidateProductBatchIds = await this.resolveSourceProductBatchIds(tx, params);
    if (!candidateProductBatchIds.length) return null;

    const recalls = await tx.batchRecall.findMany({
      where: { productBatchId: { in: Array.from(candidateProductBatchIds) }, status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
    });
    if (!recalls.length) return null;

    return {
      recallId: recalls[0].id,
      productBatchId: recalls[0].productBatchId,
      allRecalledProductBatchIds: recalls.map((r: any) => r.productBatchId),
    };
  }

  // Physically receives a returned unit already known (via
  // findRecallForSoldItem) to trace back to a recalled ProductBatch.
  // Credits it as real warehouse stock — the goods ARE physically back,
  // occupying space, awaiting disposition — but pinned to status RETURNED,
  // never APPROVED, so depleteBatchesFIFO can never draw from it (same
  // convention as collectReturn's formal recall-workflow return). Feeds the
  // SAME BatchRecall.returnedQty counter collectReturn uses so recall
  // reporting stays consistent no matter which UI a return came through.
  //
  // Deliberately does NOT cap returnedQty at distributedQty the way
  // collectReturn does: a customer walking in with a physical unit must
  // always be accepted into quarantine, never rejected because of a
  // bookkeeping mismatch — and works even when recall.status is COMPLETED,
  // since an organic customer return can arrive at any time, not only
  // during the structured recall workflow's own step sequence.
  static async recordRecallAffectedReturn(tx: any, params: {
    recallId: string;
    productBatchId: string;
    inventoryItemId: string;
    quantity: number;
    warehouseId?: string | null;
    userId?: string;
    source: string;
    sourceId: string;
    allRecalledProductBatchIds?: string[];
    note: string;
  }) {
    const qty = Number(params.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return null;

    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: params.inventoryItemId } });
    const productBatch = await tx.productBatch.findUnique({ where: { id: params.productBatchId }, select: { batchCode: true } });

    const newBatch = await tx.inventoryBatch.create({
      data: {
        inventoryItemId: params.inventoryItemId,
        batchNumber: productBatch?.batchCode ? `${productBatch.batchCode}-RETURN` : `RECALL-RETURN-${Date.now()}`,
        initialQty: qty,
        currentQty: qty,
        unitCost: item.costPrice || 0,
        productBatchId: params.productBatchId,
        warehouseId: params.warehouseId || null,
        status: 'RETURNED',
      },
    });

    await tx.inventoryItem.update({
      where: { id: params.inventoryItemId },
      data: { currentStock: { increment: qty } },
    });

    await tx.stockMovement.create({
      data: {
        itemId: params.inventoryItemId,
        movementType: 'RECALL_RETURN_IN',
        quantity: qty,
        referenceType: 'RECALL',
        referenceId: params.recallId,
        batchId: newBatch.id,
        note: params.note,
        createdBy: params.userId,
        warehouseId: params.warehouseId || null,
      },
    });

    await tx.batchRecall.update({
      where: { id: params.recallId },
      data: { returnedQty: { increment: qty } },
    });

    await tx.batchRecallEvent.create({
      data: {
        recallId: params.recallId,
        event: 'RETURN_COLLECTED',
        status: 'SUCCESS',
        actor: params.userId || 'system',
        affectedQty: qty,
        details: {
          source: params.source,
          sourceId: params.sourceId,
          allRecalledProductBatchIds: params.allRecalledProductBatchIds || [params.productBatchId],
          message: params.note,
        } as any,
      },
    });

    return newBatch;
  }
}
