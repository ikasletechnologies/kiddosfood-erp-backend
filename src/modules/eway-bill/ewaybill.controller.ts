import { Request, Response, NextFunction } from 'express';
import { EWayBillService } from './ewaybill.service';
import {
  SUB_SUPPLY_TYPES, SUPPLY_DOC_MATRIX, DOC_TYPES, TRANS_MODES, CANCEL_REASONS, VEHICLE_UPDATE_REASONS, EXTENSION_REASONS, EWB_THRESHOLD,
} from './ewaybill.constants';

// Errors go to next() so AppError status codes (404/409/422) reach the client.
const handle = (fn: (req: Request, user: any) => Promise<any>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await fn(req, (req as any).user));
    } catch (err) {
      next(err);
    }
  };

export class EWayBillController {
  static masters = handle(async () => ({
    subSupplyTypes: SUB_SUPPLY_TYPES,
    supplyDocMatrix: SUPPLY_DOC_MATRIX,
    docTypes: DOC_TYPES,
    transModes: TRANS_MODES,
    cancelReasons: CANCEL_REASONS,
    vehicleUpdateReasons: VEHICLE_UPDATE_REASONS,
    extensionReasons: EXTENSION_REASONS,
    threshold: EWB_THRESHOLD,
    consignor: await EWayBillService.consignorDefaults(),
  }));

  static list = handle((req, user) => EWayBillService.list(user, req.query as any));
  static stats = handle((req, user) => EWayBillService.stats(user, req.query.franchiseId as string));
  static sources = handle((req, user) => EWayBillService.listSources(user, String(req.query.sourceType || ''), req.query.search as string));
  static prefill = handle((req, user) => EWayBillService.prefill(user, String(req.query.sourceType || ''), String(req.query.sourceId || '')));
  static getOne = handle((req, user) => EWayBillService.getById(user, req.params.id));
  static create = handle((req, user) => EWayBillService.create(user, req.body));
  static update = handle((req, user) => EWayBillService.update(user, req.params.id, req.body));
  static remove = handle((req, user) => EWayBillService.remove(user, req.params.id));
  static generate = handle((req, user) => EWayBillService.markGenerated(user, req.params.id, req.body));
  static updateVehicle = handle((req, user) => EWayBillService.updateVehicle(user, req.params.id, req.body));
  static extend = handle((req, user) => EWayBillService.extendValidity(user, req.params.id, req.body));
  static cancel = handle((req, user) => EWayBillService.cancel(user, req.params.id, req.body));
  static exportJson = handle((req, user) => EWayBillService.exportNicJson(user, Array.isArray(req.body?.ids) ? req.body.ids : []));
}
