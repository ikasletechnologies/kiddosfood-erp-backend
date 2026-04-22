import { Request, Response } from 'express';
import { ServiceCRMService } from './service-crm.service';

export class ServiceCRMController {
  // ─── Tickets ────────────────────────────────────────────────────────────────

  static async getTickets(req: Request, res: Response) {
    try {
      const tickets = await ServiceCRMService.getTickets({
        status: req.query.status as string,
        type: req.query.type as string,
        priority: req.query.priority as string,
        assigneeId: req.query.assigneeId as string,
        search: req.query.search as string
      });
      res.json(tickets);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getTicket(req: Request, res: Response) {
    try {
      const ticket = await ServiceCRMService.getTicketById(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      res.json(ticket);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createTicket(req: Request, res: Response) {
    try {
      const creatorId = (req as any).user?.id;
      const ticket = await ServiceCRMService.createTicket({ ...req.body, creatorId });
      res.status(201).json(ticket);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateTicket(req: Request, res: Response) {
    try {
      const ticket = await ServiceCRMService.updateTicket(req.params.id, req.body);
      res.json(ticket);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteTicket(req: Request, res: Response) {
    try {
      await ServiceCRMService.deleteTicket(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getStats(req: Request, res: Response) {
    try {
      const stats = await ServiceCRMService.getTicketStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Field Visits ────────────────────────────────────────────────────────────

  static async getFieldVisits(req: Request, res: Response) {
    try {
      const visits = await ServiceCRMService.getFieldVisits({
        ticketId: req.query.ticketId as string,
        agentId: req.query.agentId as string,
        status: req.query.status as string
      });
      res.json(visits);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createFieldVisit(req: Request, res: Response) {
    try {
      const visit = await ServiceCRMService.createFieldVisit(req.body);
      res.status(201).json(visit);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async checkIn(req: Request, res: Response) {
    try {
      const visit = await ServiceCRMService.checkInVisit(req.params.id, req.body);
      res.json(visit);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async checkOut(req: Request, res: Response) {
    try {
      const visit = await ServiceCRMService.checkOutVisit(req.params.id, req.body);
      res.json(visit);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async logLocation(req: Request, res: Response) {
    try {
      const log = await ServiceCRMService.logLocation(req.params.id, req.body);
      res.status(201).json(log);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateVisitStatus(req: Request, res: Response) {
    try {
      const visit = await ServiceCRMService.updateVisitStatus(req.params.id, req.body);
      res.json(visit);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
