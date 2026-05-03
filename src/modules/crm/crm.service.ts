import prisma from '../../lib/prisma';
import { LeadStatus } from '@prisma/client';

export class CRMService {
  // ─── Pipelines ──────────────────────────────────────────────────────────────

  static async getAllPipelines() {
    const pipelines = await prisma.pipeline.findMany({
      include: { leads: true, crmForms: true },
      orderBy: { createdAt: 'asc' }
    });

    return pipelines.map((p) => ({
      ...p,
      stages: p.stages.map((label) => ({
        label,
        count: p.leads.filter((l) => {
          const map: Record<string, LeadStatus> = {
            Open: 'OPEN',
            Contacted: 'CONTACTED',
            'Proposal Sent': 'PROPOSAL_SENT',
            'Deal Done': 'DEAL_DONE',
            Lost: 'LOST',
            'Not Serviceable': 'NOT_SERVICEABLE'
          };
          return l.status === (map[label] as LeadStatus);
        }).length
      }))
    }));
  }

  static async createPipeline(data: { name: string; description?: string; stages?: string[] }) {
    return prisma.pipeline.create({ data });
  }

  static async updatePipeline(id: string, data: { name?: string; description?: string; stages?: string[] }) {
    return prisma.pipeline.update({ where: { id }, data });
  }

  static async deletePipeline(id: string) {
    return prisma.pipeline.delete({ where: { id } });
  }

  // ─── Leads ───────────────────────────────────────────────────────────────────

  static async getLeads(filters: {
    pipelineId?: string;
    status?: LeadStatus;
    search?: string;
    assigneeId?: string;
  }) {
    return prisma.lead.findMany({
      where: {
        ...(filters.pipelineId ? { pipelineId: filters.pipelineId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
        ...(filters.search
          ? {
              OR: [
                { contactName: { contains: filters.search, mode: 'insensitive' } },
                { orgName: { contains: filters.search, mode: 'insensitive' } },
                { email: { contains: filters.search, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      include: { pipeline: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getLeadById(id: string) {
    return prisma.lead.findUnique({ where: { id }, include: { pipeline: true } });
  }

  static async createLead(data: {
    pipelineId: string;
    contactName: string;
    orgName?: string;
    email?: string;
    phone?: string;
    designation?: string;
    contactCountry?: string;
    customerCountry?: string;
    customerCity?: string;
    leadSource?: string;
    budget?: number;
    subject?: string;
    status?: LeadStatus;
    assigneeId?: string;
    creatorId?: string;
    followUpDate?: string;
  }) {
    return prisma.lead.create({
      data: {
        ...data,
        followUpDate: data.followUpDate ? new Date(data.followUpDate) : undefined
      },
      include: { pipeline: true }
    });
  }

  static async updateLead(id: string, data: Partial<{
    contactName: string;
    orgName: string;
    email: string;
    phone: string;
    designation: string;
    contactCountry: string;
    customerCity: string;
    leadSource: string;
    budget: number;
    subject: string;
    status: LeadStatus;
    assigneeId: string;
    followUpDate: string;
    closedAt: string;
  }>) {
    const updatedLead = await prisma.lead.update({
      where: { id },
      data: {
        ...data,
        followUpDate: data.followUpDate ? new Date(data.followUpDate) : undefined,
        closedAt: data.closedAt ? new Date(data.closedAt) : undefined
      },
      include: { pipeline: true }
    });

    // Phase 6: Automated Customer Creation on WON
    if (data.status === LeadStatus.WON || data.status === LeadStatus.DEAL_DONE) {
        const phone = updatedLead.phone;
        if (phone) {
            const existingCustomer = await prisma.customer.findUnique({
                where: { phone }
            });

            if (!existingCustomer) {
                await prisma.customer.create({
                    data: {
                        name: updatedLead.contactName,
                        phone: updatedLead.phone,
                        email: updatedLead.email
                    }
                });
            }
        }
    }

    return updatedLead;
  }

  static async deleteLead(id: string) {
    return prisma.lead.update({
      where: { id },
      data: { status: 'DELETED' }
    });
  }

  // ─── Forms ───────────────────────────────────────────────────────────────────

  static async getForms(filters: { pipelineId?: string; status?: string }) {
    return prisma.cRMForm.findMany({
      where: {
        ...(filters.pipelineId ? { pipelineId: filters.pipelineId } : {}),
        ...(filters.status && typeof filters.status === 'string' && filters.status !== 'All'
          ? { status: filters.status.toUpperCase() }
          : {})
      },
      include: { pipeline: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async createForm(data: { name: string; pipelineId: string; creatorId?: string }) {
    return prisma.cRMForm.create({
      data: { ...data, status: 'ACTIVE' },
      include: { pipeline: true }
    });
  }

  static async updateForm(id: string, data: { name?: string; status?: string }) {
    return prisma.cRMForm.update({ where: { id }, data, include: { pipeline: true } });
  }

  static async deleteForm(id: string) {
    return prisma.cRMForm.delete({ where: { id } });
  }

  // ─── Reports / Analytics ─────────────────────────────────────────────────────

  static async getLeadSourceReport(filters: {
    pipelineId?: string;
    dateFrom?: string;
    dateTo?: string;
    assigneeId?: string;
  }) {
    const where: any = {};
    if (filters.pipelineId) where.pipelineId = filters.pipelineId;
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {
        ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
        ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {})
      };
    }
    if (filters.assigneeId) where.assigneeId = filters.assigneeId;

    const leads = await prisma.lead.findMany({ where });

    const grouped: Record<string, { leads: typeof leads }> = {};
    for (const lead of leads) {
      const src = lead.leadSource || 'Unknown';
      if (!grouped[src]) grouped[src] = { leads: [] };
      grouped[src].leads.push(lead);
    }

    return Object.entries(grouped).map(([source, { leads: srcLeads }]) => {
      const closed = srcLeads.filter((l) => l.status === 'DEAL_DONE');
      const open = srcLeads.filter((l) => ['OPEN', 'NEW', 'CONTACTED', 'PROPOSAL_SENT'].includes(l.status));
      const lost = srcLeads.filter((l) => l.status === 'LOST');
      const notServiceable = srcLeads.filter((l) => l.status === 'NOT_SERVICEABLE');
      const totalRevenue = closed.reduce((s, l) => s + (l.budget || 0), 0);
      const avgDealValue = closed.length ? totalRevenue / closed.length : 0;
      const conversionRate = srcLeads.length ? (closed.length / srcLeads.length) * 100 : 0;

      const closureTimes = closed
        .filter((l) => l.closedAt)
        .map((l) => Math.floor((l.closedAt!.getTime() - l.createdAt.getTime()) / 86400000));
      const avgClosureTime = closureTimes.length
        ? Math.round(closureTimes.reduce((a, b) => a + b, 0) / closureTimes.length)
        : 0;

      return {
        leadSource: source,
        totalRevenue,
        conversionRate: Number(conversionRate.toFixed(1)),
        leadsGenerated: srcLeads.length,
        openLeads: open.length,
        closedLeads: closed.length,
        lostLeads: lost.length,
        notServiceable: notServiceable.length,
        avgDealValue: Number(avgDealValue.toFixed(2)),
        avgClosureTimeDays: avgClosureTime
      };
    });
  }

  static async getTeamSalesReport(filters: { pipelineId?: string; dateFrom?: string; dateTo?: string }) {
    const where: any = {};
    if (filters.pipelineId) where.pipelineId = filters.pipelineId;
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {
        ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
        ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {})
      };
    }

    const leads = await prisma.lead.findMany({ where });
    const grouped: Record<string, typeof leads> = {};
    for (const lead of leads) {
      const assignee = lead.assigneeId || 'Unassigned';
      if (!grouped[assignee]) grouped[assignee] = [];
      grouped[assignee].push(lead);
    }

    return Object.entries(grouped).map(([assigneeId, assigneeLeads]) => {
      const closed = assigneeLeads.filter((l) => l.status === 'DEAL_DONE');
      const revenue = closed.reduce((s, l) => s + (l.budget || 0), 0);
      return {
        assigneeId,
        totalLeads: assigneeLeads.length,
        closedLeads: closed.length,
        totalRevenue: revenue,
        conversionRate: assigneeLeads.length
          ? Number(((closed.length / assigneeLeads.length) * 100).toFixed(1))
          : 0
      };
    });
  }

  static async getClientPerformanceReport(filters: { pipelineId?: string; dateFrom?: string; dateTo?: string }) {
    const where: any = {};
    if (filters.pipelineId) where.pipelineId = filters.pipelineId;
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {
        ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
        ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {})
      };
    }

    const leads = await prisma.lead.findMany({ where });
    const grouped: Record<string, typeof leads> = {};
    for (const lead of leads) {
      const org = lead.orgName || 'Unknown';
      if (!grouped[org]) grouped[org] = [];
      grouped[org].push(lead);
    }

    return Object.entries(grouped).map(([orgName, orgLeads]) => {
      const closed = orgLeads.filter((l) => l.status === 'DEAL_DONE');
      const revenue = closed.reduce((s, l) => s + (l.budget || 0), 0);
      return {
        orgName,
        totalLeads: orgLeads.length,
        closedLeads: closed.length,
        totalRevenue: revenue,
        conversionRate: orgLeads.length
          ? Number(((closed.length / orgLeads.length) * 100).toFixed(1))
          : 0
      };
    });
  }

  // ─── Customer Insights ────────────────────────────────────────────────────────
  
  static async getCustomerSummary(customerId: string) {
      const customer = await prisma.customer.findUnique({
          where: { id: customerId },
          include: { 
              orders: {
                  include: { orderItems: { include: { product: true } } },
                  orderBy: { createdAt: 'desc' }
              }
          }
      });

      if (!customer) throw new Error('Customer not found');

      const totalSpent = customer.orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
      const avgOrderValue = customer.orders.length ? totalSpent / customer.orders.length : 0;

      return {
          customer,
          totalSpent,
          orderCount: customer.orders.length,
          avgOrderValue,
          lastOrderDate: customer.orders[0]?.createdAt || null
      };
  }
}
