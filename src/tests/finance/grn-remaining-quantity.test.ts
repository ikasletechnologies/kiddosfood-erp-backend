import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma';
import { GRNService } from '../../modules/grn/grn.service';

// Safe-by-construction, same pattern as the other mocked tests in this
// folder: prisma.$transaction and every model method createFromPO touches
// are monkey-patched with fabricated in-memory data — no real query, no
// live DB read/write. Calls the REAL GRNService.createFromPO.
//
// Regression target: "New Receipt" let a partially-received PO line be
// received again up to its FULL original ordered quantity (Ordered: 8,
// Received input allowed up to 8) even after 6 of the 8 had already been
// received and accepted in an earlier, COMPLETED GRN — createFromPO never
// computed or enforced a remaining-receivable cap at all. The fix computes
// cumulative received from COMPLETED GoodsReceiptItem rows (the same basis
// GRNService.approve already uses for PO status transitions) and rejects
// any requested receivedQty exceeding what's left, under a row lock on the
// parent ProcurementOrder.

let failures = 0;
const check = (label: string, cond: boolean, extra?: string) => {
  if (cond) console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
  else { console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`); failures++; }
};

interface FakeCompletedItem { poId: string; grnId: string; materialId: string; receivedQty: number; }

function installMocks(opts: {
  po: { id: string; poNumber: string; status: string; poItems: Array<{ inventoryItemId: string; quantity: number; price: number; unit: string; itemName: string }> };
  completedItems: FakeCompletedItem[];
}) {
  let grnCounter = 0;
  const tx = {
    $queryRaw: async () => [{ id: opts.po.id }], // row-lock no-op in this mock
    procurementOrder: {
      findUnique: async (args: any) => (args.where.id === opts.po.id ? { ...opts.po } : null),
    },
    goodsReceiptItem: {
      findMany: async (args: any) => {
        const w = args.where;
        const poId = w.grn.poId;
        const excludeId = w.grn.id?.not;
        return opts.completedItems
          .filter((i) => i.poId === poId && (!excludeId || i.grnId !== excludeId))
          .map((i) => ({ materialId: i.materialId, receivedQty: i.receivedQty }));
      },
    },
    goodsReceipt: {
      create: async (args: any) => {
        grnCounter++;
        const id = `grn-${grnCounter}`;
        return {
          id,
          poId: args.data.poId,
          status: args.data.status,
          items: args.data.items.create.map((it: any, i: number) => ({ id: `gi-${grnCounter}-${i}`, ...it })),
        };
      },
    },
  };
  (prisma as any).$transaction = async (fn: any) => fn(tx);
}

function makeItem(overrides: Partial<{ materialId: string; orderedQty: number; receivedQty: number; acceptedQty: number; rejectedQty: number; price: number; lotNumber: string; expDate: string }>) {
  return {
    materialId: overrides.materialId ?? 'mat-1',
    orderedQty: overrides.orderedQty ?? 8,
    receivedQty: overrides.receivedQty ?? 0,
    acceptedQty: overrides.acceptedQty ?? (overrides.receivedQty ?? 0),
    rejectedQty: overrides.rejectedQty ?? 0,
    price: overrides.price ?? 20,
  };
}

const basePO = {
  id: 'po-1',
  poNumber: 'PO-2026-001',
  status: 'PARTIALLY_RECEIVED',
  poItems: [{ inventoryItemId: 'mat-1', quantity: 8, price: 20, unit: 'KG', itemName: 'Idli Rice' }],
};

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING GRN REMAINING-QUANTITY VALIDATION (mocked, no DB writes)');
  console.log('====================================================\n');

  // 1. PO 8, first GRN (completed) 6 → remaining 2. Second GRN for exactly 2 succeeds.
  {
    installMocks({ po: basePO, completedItems: [{ poId: 'po-1', grnId: 'grn-0', materialId: 'mat-1', receivedQty: 6 }] });
    const grn = await GRNService.createFromPO('po-1', { items: [makeItem({ receivedQty: 2, acceptedQty: 2 })] });
    check('1. Second GRN for exactly the remaining 2 succeeds', grn.items[0].receivedQty === 2, `got ${grn.items[0].receivedQty}`);
  }

  // 2. Second GRN cannot receive 3 (only 2 remains)
  {
    installMocks({ po: basePO, completedItems: [{ poId: 'po-1', grnId: 'grn-0', materialId: 'mat-1', receivedQty: 6 }] });
    let threw = false;
    let message = '';
    try {
      await GRNService.createFromPO('po-1', { items: [makeItem({ receivedQty: 3, acceptedQty: 3 })] });
    } catch (e: any) {
      threw = true;
      message = e.message;
    }
    check('2. Requesting 3 when only 2 remains is rejected', threw, message);
    check('2. Error message names the actual remaining amount (2)', /only 2/.test(message), message);
  }

  // 3. Requesting the full original 8 again (the exact reported bug) is rejected
  {
    installMocks({ po: basePO, completedItems: [{ poId: 'po-1', grnId: 'grn-0', materialId: 'mat-1', receivedQty: 6 }] });
    let threw = false;
    try {
      await GRNService.createFromPO('po-1', { items: [makeItem({ receivedQty: 8, acceptedQty: 8 })] });
    } catch (e: any) {
      threw = true;
    }
    check('3. Re-requesting the full original 8 (ignoring the prior 6 received) is rejected', threw);
  }

  // 4. After receiving the remaining 2 (cumulative now 8), a third GRN cannot receive anything
  {
    installMocks({
      po: basePO,
      completedItems: [
        { poId: 'po-1', grnId: 'grn-0', materialId: 'mat-1', receivedQty: 6 },
        { poId: 'po-1', grnId: 'grn-1', materialId: 'mat-1', receivedQty: 2 },
      ],
    });
    let threw = false;
    let message = '';
    try {
      await GRNService.createFromPO('po-1', { items: [makeItem({ receivedQty: 1, acceptedQty: 1 })] });
    } catch (e: any) {
      threw = true;
      message = e.message;
    }
    check('4. Fully-received PO (cumulative 8/8): third GRN cannot receive anything', threw, message);
    check('4. Error correctly reports 0 remaining', /only 0/.test(message), message);
  }

  // 5. Multiple PO lines calculate independently
  {
    const twoLinePO = {
      id: 'po-2',
      poNumber: 'PO-2026-002',
      status: 'PARTIALLY_RECEIVED',
      poItems: [
        { inventoryItemId: 'mat-a', quantity: 10, price: 5, unit: 'KG', itemName: 'Item A' },
        { inventoryItemId: 'mat-b', quantity: 4, price: 50, unit: 'PCS', itemName: 'Item B' },
      ],
    };
    installMocks({
      po: twoLinePO,
      completedItems: [
        { poId: 'po-2', grnId: 'grn-0', materialId: 'mat-a', receivedQty: 7 }, // remaining 3
        { poId: 'po-2', grnId: 'grn-0', materialId: 'mat-b', receivedQty: 1 }, // remaining 3
      ],
    });
    // Line A: request 3 (ok, remaining 3). Line B: request 4 (should fail, only 3 remains).
    let threwForB = false;
    try {
      await GRNService.createFromPO('po-2', {
        items: [
          makeItem({ materialId: 'mat-a', orderedQty: 10, receivedQty: 3, acceptedQty: 3, price: 5 }),
          makeItem({ materialId: 'mat-b', orderedQty: 4, receivedQty: 4, acceptedQty: 4, price: 50 }),
        ],
      });
    } catch (e: any) {
      threwForB = /Item B/.test(e.message);
    }
    check('5. Multiple PO lines validated independently — Line B over-request rejected without blocking on Line A', threwForB);

    // Now the same PO, both lines within their own remaining — should succeed.
    const grn = await GRNService.createFromPO('po-2', {
      items: [
        makeItem({ materialId: 'mat-a', orderedQty: 10, receivedQty: 3, acceptedQty: 3, price: 5 }),
        makeItem({ materialId: 'mat-b', orderedQty: 4, receivedQty: 3, acceptedQty: 3, price: 50 }),
      ],
    });
    check('5. Both lines within their own remaining succeed together', grn.items.length === 2);
  }

  // 6. Accepted/rejected split preserved (existing semantics untouched by this fix)
  {
    installMocks({ po: basePO, completedItems: [{ poId: 'po-1', grnId: 'grn-0', materialId: 'mat-1', receivedQty: 6 }] });
    const grn = await GRNService.createFromPO('po-1', { items: [makeItem({ receivedQty: 2, acceptedQty: 1, rejectedQty: 1 })] });
    check('6. Accepted/rejected split preserved: received=2, accepted=1, rejected=1', grn.items[0].receivedQty === 2 && grn.items[0].acceptedQty === 1 && grn.items[0].rejectedQty === 1);
  }

  // 7. Multiple GRNs accumulate correctly (three completed GRNs summed before validating a fourth)
  {
    installMocks({
      po: { ...basePO, poItems: [{ inventoryItemId: 'mat-1', quantity: 20, price: 20, unit: 'KG', itemName: 'Idli Rice' }] },
      completedItems: [
        { poId: 'po-1', grnId: 'grn-0', materialId: 'mat-1', receivedQty: 5 },
        { poId: 'po-1', grnId: 'grn-1', materialId: 'mat-1', receivedQty: 5 },
        { poId: 'po-1', grnId: 'grn-2', materialId: 'mat-1', receivedQty: 5 },
      ],
    });
    // Ordered 20, received 15 so far -> remaining 5.
    let threw = false;
    try {
      await GRNService.createFromPO('po-1', { items: [makeItem({ orderedQty: 20, receivedQty: 6, acceptedQty: 6 })] });
    } catch (e: any) {
      threw = true;
    }
    check('7. Three prior completed GRNs (5+5+5=15) correctly summed; requesting 6 against remaining 5 is rejected', threw);

    const grn = await GRNService.createFromPO('po-1', { items: [makeItem({ orderedQty: 20, receivedQty: 5, acceptedQty: 5 })] });
    check('7. Requesting exactly the remaining 5 succeeds', grn.items[0].receivedQty === 5);
  }

  // 8. Cancelled PO / closed PO still blocked (pre-existing guard, unaffected by this fix)
  {
    installMocks({ po: { ...basePO, status: 'CANCELLED' }, completedItems: [] });
    let threw = false;
    try {
      await GRNService.createFromPO('po-1', { items: [makeItem({ receivedQty: 1, acceptedQty: 1 })] });
    } catch (e: any) {
      threw = true;
    }
    check('8. Cancelled PO still blocks GRN creation (pre-existing behavior preserved)', threw);
  }

  // 9. Structural check: approve() has the same lock + defensive re-validation
  {
    const src = fs.readFileSync(path.join(__dirname, '../../modules/grn/grn.service.ts'), 'utf8');
    const approveFn = src.slice(src.indexOf('static async approve('));
    check('9. approve() takes the same ProcurementOrder row lock as createFromPO', /FOR UPDATE/.test(approveFn));
    check('9. approve() re-validates cumulative received against ordered quantity before posting inventory', /getCumulativeReceived/.test(approveFn) && /projected > poItem\.quantity/.test(approveFn));
  }

  console.log('\n====================================================');
  if (failures > 0) console.error(`❌ ${failures} check(s) FAILED`);
  else console.log('✅ ALL CHECKS PASSED');
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error running GRN remaining-quantity validation:', err);
  process.exit(1);
});
