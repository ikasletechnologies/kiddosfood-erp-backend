import { Request, Response } from 'express';
import { GstService, GstVerifyError } from './gst.service';

export class GstController {
  static async verify(req: Request, res: Response) {
    try {
      const gstin = String(req.params.gstin || '');
      const forceRefresh = req.query.refresh === 'true';
      const { details, cached } = await GstService.verify(gstin, forceRefresh);
      res.json({ success: true, cached, ...details });
    } catch (error) {
      const status = error instanceof GstVerifyError ? error.status : 502;
      res.status(status).json({ success: false, error: (error as Error).message });
    }
  }
}
