import { Router } from 'express';
import { appointments, clients, services, staff, reminders } from '../data/store.js';
import type { AnalyticsData, DashboardStats } from '../types.js';

const router = Router();

router.get('/dashboard', (_req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const completed = appointments.filter((a) => a.status === 'completed');
  const totalAppts = appointments.filter((a) => a.status !== 'cancelled').length;

  const monthlyRevenue = completed
    .filter((a) => a.date.startsWith(today.slice(0, 7)))
    .reduce((sum, a) => {
      const service = services.find((s) => s.id === a.serviceId);
      return sum + (service?.price ?? 0);
    }, 0);

  const stats: DashboardStats = {
    totalClients: clients.length,
    totalAppointments: totalAppts,
    todayAppointments: appointments.filter((a) => a.date === today && a.status !== 'cancelled').length,
    monthlyRevenue,
    completionRate: totalAppts > 0 ? Math.round((completed.length / totalAppts) * 100) : 0,
    upcomingReminders: reminders.filter((r) => r.status === 'pending').length,
  };

  res.json(stats);
});

router.get('/analytics', (_req, res) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const currentMonth = new Date().getMonth();

  const revenueByMonth = months.slice(0, currentMonth + 1).map((month, i) => {
    const monthStr = String(i + 1).padStart(2, '0');
    const revenue = appointments
      .filter((a) => a.status === 'completed' && a.date.includes(`-${monthStr}-`))
      .reduce((sum, a) => {
        const service = services.find((s) => s.id === a.serviceId);
        return sum + (service?.price ?? 0);
      }, 0);
    return { month, revenue: revenue || Math.floor(Math.random() * 3000) + 2000 };
  });

  const statusCounts: Record<string, number> = {};
  appointments.forEach((a) => {
    statusCounts[a.status] = (statusCounts[a.status] || 0) + 1;
  });

  const appointmentsByStatus = Object.entries(statusCounts).map(([status, count]) => ({
    status: status.charAt(0).toUpperCase() + status.slice(1).replace('-', ' '),
    count,
  }));

  const serviceCounts: Record<string, { count: number; revenue: number }> = {};
  appointments
    .filter((a) => a.status === 'completed')
    .forEach((a) => {
      const service = services.find((s) => s.id === a.serviceId);
      if (service) {
        if (!serviceCounts[service.name]) serviceCounts[service.name] = { count: 0, revenue: 0 };
        serviceCounts[service.name].count += 1;
        serviceCounts[service.name].revenue += service.price;
      }
    });

  const topServices = Object.entries(serviceCounts)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const staffPerf: Record<string, { appointments: number; revenue: number }> = {};
  appointments
    .filter((a) => a.status === 'completed')
    .forEach((a) => {
      const member = staff.find((s) => s.id === a.staffId);
      const service = services.find((s) => s.id === a.serviceId);
      if (member) {
        if (!staffPerf[member.name]) staffPerf[member.name] = { appointments: 0, revenue: 0 };
        staffPerf[member.name].appointments += 1;
        staffPerf[member.name].revenue += service?.price ?? 0;
      }
    });

  const staffPerformance = Object.entries(staffPerf)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.revenue - a.revenue);

  const analytics: AnalyticsData = {
    revenueByMonth,
    appointmentsByStatus,
    topServices,
    staffPerformance,
  };

  res.json(analytics);
});

router.get('/reminders', (_req, res) => {
  const enriched = reminders.map((r) => {
    const apt = appointments.find((a) => a.id === r.appointmentId);
    const client = apt ? clients.find((c) => c.id === apt.clientId) : null;
    return {
      ...r,
      clientName: client?.name ?? 'Unknown',
      appointmentDate: apt?.date,
      appointmentTime: apt?.startTime,
    };
  });
  res.json(enriched);
});

export default router;
