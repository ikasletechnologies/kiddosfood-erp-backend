import { Request, Response } from 'express';
import { CRMService } from './crm.service';
import { LeadStatus } from '@prisma/client';

export class CRMController {
  // ─── Pipelines ──────────────────────────────────────────────────────────────
  static async getPipelines(req: Request, res: Response) {
    try {
      const pipelines = await CRMService.getAllPipelines();
      res.json(pipelines);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createPipeline(req: Request, res: Response) {
    try {
      const pipeline = await CRMService.createPipeline(req.body);
      res.status(201).json(pipeline);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updatePipeline(req: Request, res: Response) {
    try {
      const pipeline = await CRMService.updatePipeline(req.params.id, req.body);
      res.json(pipeline);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deletePipeline(req: Request, res: Response) {
    try {
      await CRMService.deletePipeline(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Leads ───────────────────────────────────────────────────────────────────
  static async getLeads(req: Request, res: Response) {
    try {
      const leads = await CRMService.getLeads({
        pipelineId: req.query.pipelineId as string,
        status: req.query.status as LeadStatus,
        search: req.query.search as string,
        assigneeId: req.query.assigneeId as string
      });
      res.json(leads);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getLead(req: Request, res: Response) {
    try {
      const lead = await CRMService.getLeadById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      res.json(lead);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createLead(req: Request, res: Response) {
    try {
      const creatorId = (req as any).user?.userId;
      const lead = await CRMService.createLead({ ...req.body, creatorId });
      res.status(201).json(lead);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateLead(req: Request, res: Response) {
    try {
      const lead = await CRMService.updateLead(req.params.id, req.body);
      res.json(lead);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteLead(req: Request, res: Response) {
    try {
      await CRMService.deleteLead(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Forms ───────────────────────────────────────────────────────────────────
  static async getForms(req: Request, res: Response) {
    try {
      const forms = await CRMService.getForms({
        pipelineId: req.query.pipelineId as string,
        status: req.query.status as string
      });
      res.json(forms);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createForm(req: Request, res: Response) {
    try {
      const creatorId = (req as any).user?.userId;
      const form = await CRMService.createForm({ ...req.body, creatorId });
      res.status(201).json(form);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateForm(req: Request, res: Response) {
    try {
      const form = await CRMService.updateForm(req.params.id, req.body);
      res.json(form);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteForm(req: Request, res: Response) {
    try {
      await CRMService.deleteForm(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Reports ─────────────────────────────────────────────────────────────────
  static async getLeadSourceReport(req: Request, res: Response) {
    try {
      const data = await CRMService.getLeadSourceReport({
        pipelineId: req.query.pipelineId as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
        assigneeId: req.query.assigneeId as string
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getTeamSalesReport(req: Request, res: Response) {
    try {
      const data = await CRMService.getTeamSalesReport({
        pipelineId: req.query.pipelineId as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getClientPerformanceReport(req: Request, res: Response) {
    try {
      const data = await CRMService.getClientPerformanceReport({
        pipelineId: req.query.pipelineId as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
