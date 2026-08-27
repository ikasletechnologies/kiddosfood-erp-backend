import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';

// Single source of truth for "has this deployment completed its first-run
// setup" — a Headquarters franchise plus that franchise's primary
// warehouse. Every module that used to silently self-heal (auto-create a
// "Default"/"Main Headquarters" franchise or an unlinked warehouse) should
// instead point the user at the explicit setup wizard driven by this status.
export class SystemSetupService {
  static async getSetupStatus() {
    let hq;
    try {
      hq = await FranchiseService.getHqFranchiseOrNull();
    } catch {
      // More than one isHQ=true franchise — a data-integrity problem, not
      // "first run". Surfaced distinctly so the frontend shows a support
      // message instead of sending the admin into a wizard whose "Create
      // Headquarters" step would immediately fail on assertSingleHQ.
      return {
        initialized: false,
        hqConfigured: false,
        hqWarehouseConfigured: false,
        hq: null,
        warehouse: null,
        error: 'MULTIPLE_HQ',
      };
    }

    const warehouse = hq?.primaryWarehouseId
      ? await prisma.warehouse.findUnique({ where: { id: hq.primaryWarehouseId } })
      : null;

    return {
      initialized: !!hq && !!warehouse,
      hqConfigured: !!hq,
      hqWarehouseConfigured: !!warehouse,
      hq: hq ? { id: hq.id, name: hq.name } : null,
      warehouse: warehouse ? { id: warehouse.id, name: warehouse.name } : null,
    };
  }

  static async isSystemInitialized() {
    return (await this.getSetupStatus()).initialized;
  }
}
