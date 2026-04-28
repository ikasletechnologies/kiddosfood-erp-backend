import { Prisma, TicketStatus, TicketType } from '@prisma/client';
import prisma from '../../lib/prisma';

let ticketCounter = 1000;

function generateTicketNumber() {
  return `TKT-${Date.now()}-${++ticketCounter}`;
}

export class ServiceCRMService {
  // ─── Tickets ────────────────────────────────────────────────────────────────

  static async getTickets(filters: {
    status?: string;
    type?: string;
    priority?: string;
    assigneeId?: string;
    search?: string;
  }) {
    const where: Prisma.ServiceTicketWhereInput = {};
    if (filters.status) where.status = filters.status as TicketStatus;
    if (filters.type) where.type = filters.type as TicketType;
    if (filters.priority) where.priority = filters.priority;
    if (filters.assigneeId) where.assigneeId = filters.assigneeId;
    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { ticketNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.serviceTicket.findMany({
      where,
      include: { customer: true, fieldVisits: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getTicketById(id: string) {
    return prisma.serviceTicket.findUnique({
      where: { id },
      include: { customer: true, fieldVisits: { include: { locationLogs: true } } }
    });
  }

  static async createTicket(data: {
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    title: string;
    description: string;
    type?: string;
    priority?: string;
    slaDeadline?: string;
    assigneeId?: string;
    creatorId?: string;
  }) {
    return prisma.serviceTicket.create({
      data: {
        ticketNumber: generateTicketNumber(),
        customerId: data.customerId,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail,
        title: data.title,
        description: data.description,
        type: (data.type as TicketType) || 'COMPLAINT',
        priority: data.priority || 'MEDIUM',
        slaDeadline: data.slaDeadline ? new Date(data.slaDeadline) : undefined,
        assigneeId: data.assigneeId,
        creatorId: data.creatorId
      },
      include: { customer: true }
    });
  }

  static async updateTicket(id: string, data: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    assigneeId?: string;
    slaDeadline?: string;
    resolvedAt?: string;
    customerFeedback?: string;
    feedbackRating?: number;
  }) {
    return prisma.serviceTicket.update({
      where: { id },
      data: {
        ...data,
        status: data.status as TicketStatus,
        slaDeadline: data.slaDeadline ? new Date(data.slaDeadline) : undefined,
        resolvedAt: data.resolvedAt ? new Date(data.resolvedAt) : undefined
      },
      include: { customer: true }
    });
  }

  static async deleteTicket(id: string) {
    return prisma.serviceTicket.delete({ where: { id } });
  }

  // ─── Field Visits ────────────────────────────────────────────────────────────

  static async getFieldVisits(filters: { ticketId?: string; agentId?: string; status?: string }) {
    const where: Prisma.FieldVisitWhereInput = {};
    if (filters.ticketId) where.ticketId = filters.ticketId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.status) where.status = filters.status;
    return prisma.fieldVisit.findMany({
      where,
      include: { ticket: true, locationLogs: { orderBy: { timestamp: 'asc' } } },
      orderBy: { scheduledAt: 'desc' }
    });
  }

  static async createFieldVisit(data: {
    ticketId: string;
    agentId: string;
    scheduledAt: string;
    remarks?: string;
  }) {
    return prisma.fieldVisit.create({
      data: {
        ticketId: data.ticketId,
        agentId: data.agentId,
        scheduledAt: new Date(data.scheduledAt),
        remarks: data.remarks
      },
      include: { ticket: true }
    });
  }

  static async checkInVisit(id: string, data: { latitude: number; longitude: number }) {
    return prisma.fieldVisit.update({
      where: { id },
      data: {
        status: 'IN_PROGRESS',
        visitedAt: new Date(),
        checkInTime: new Date(),
        checkInLat: data.latitude,
        checkInLng: data.longitude
      }
    });
  }

  static async checkOutVisit(id: string, data: {
    latitude: number;
    longitude: number;
    remarks?: string;
    distanceKm?: number;
    taAmount?: number;
  }) {
    return prisma.fieldVisit.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        checkOutTime: new Date(),
        checkOutLat: data.latitude,
        checkOutLng: data.longitude,
        remarks: data.remarks,
        distanceKm: data.distanceKm,
        taAmount: data.taAmount
      }
    });
  }

  static async logLocation(visitId: string, data: { latitude: number; longitude: number }) {
    return prisma.locationLog.create({
      data: { visitId, latitude: data.latitude, longitude: data.longitude }
    });
  }

  static async updateVisitStatus(id: string, data: { status: string; remarks?: string }) {
    return prisma.fieldVisit.update({
      where: { id },
      data: { status: data.status, remarks: data.remarks }
    });
  }

  // ─── Analytics ───────────────────────────────────────────────────────────────

  static async getTicketStats() {
    const [total, open, inProgress, resolved, closed] = await Promise.all([
      prisma.serviceTicket.count(),
      prisma.serviceTicket.count({ where: { status: 'OPEN' } }),
      prisma.serviceTicket.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.serviceTicket.count({ where: { status: 'RESOLVED' } }),
      prisma.serviceTicket.count({ where: { status: 'CLOSED' } })
    ]);

    const byType = await prisma.serviceTicket.groupBy({
      by: ['type'],
      _count: { _all: true }
    });

    const byPriority = await prisma.serviceTicket.groupBy({
      by: ['priority'],
      _count: { _all: true }
    });

    return { total, open, inProgress, resolved, closed, byType, byPriority };
  }
}
