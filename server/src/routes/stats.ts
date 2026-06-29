import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapEnrichedReminder } from '../lib/mappers.js';
import type { AnalyticsData, DashboardStats } from '../types.js';

const router = Router();

/** Local YYYY-MM-DD — avoids UTC shift from toISOString() */
function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

router.get('/dashboard', async (_req, res) => {
  const today = localDateStr();
  const monthPrefix = today.slice(0, 7);

  const [clientsRes, appointmentsRes, remindersRes] = await Promise.all([
    supabase.from('clients').select('id', { count: 'exact', head: true }),
    supabase.from('appointments').select('id, status, date, service_id'),
    supabase.from('reminders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);

  if (clientsRes.error) return res.status(500).json({ error: clientsRes.error.message });
  if (appointmentsRes.error) return res.status(500).json({ error: appointmentsRes.error.message });
  if (remindersRes.error) return res.status(500).json({ error: remindersRes.error.message });

  const appointments = appointmentsRes.data ?? [];
  const completed = appointments.filter((a) => a.status === 'completed');
  const totalAppts = appointments.filter((a) => a.status !== 'cancelled').length;

  const completedThisMonth = completed.filter((a) => a.date.startsWith(monthPrefix));
  const serviceIds = [...new Set(completedThisMonth.map((a) => a.service_id))];

  let monthlyRevenue = 0;
  if (serviceIds.length > 0) {
    const { data: services } = await supabase
      .from('services')
      .select('id, price')
      .in('id', serviceIds);

    const priceMap = new Map((services ?? []).map((s) => [s.id, Number(s.price)]));
    monthlyRevenue = completedThisMonth.reduce(
      (sum, a) => sum + (priceMap.get(a.service_id) ?? 0),
      0
    );
  }

  const stats: DashboardStats = {
    totalClients: clientsRes.count ?? 0,
    totalAppointments: totalAppts,
    todayAppointments: appointments.filter((a) => a.date === today && a.status !== 'cancelled').length,
    monthlyRevenue,
    completionRate: totalAppts > 0 ? Math.round((completed.length / totalAppts) * 100) : 0,
    upcomingReminders: remindersRes.count ?? 0,
  };

  res.json(stats);
});

router.get('/analytics', async (_req, res) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const currentMonth = new Date().getMonth();
  const year = new Date().getFullYear();

  const { data: appointments, error: aptError } = await supabase
    .from('appointments')
    .select('status, date, service_id, staff_id');

  if (aptError) return res.status(500).json({ error: aptError.message });

  const { data: services } = await supabase.from('services').select('id, name, price');
  const { data: staffMembers } = await supabase.from('staff').select('id, name');

  const serviceMap = new Map((services ?? []).map((s) => [s.id, s]));
  const staffMap = new Map((staffMembers ?? []).map((s) => [s.id, s]));
  const allAppointments = appointments ?? [];

  const revenueByMonth = months.slice(0, currentMonth + 1).map((month, i) => {
    const monthStr = String(i + 1).padStart(2, '0');
    const prefix = `${year}-${monthStr}`;
    const revenue = allAppointments
      .filter((a) => a.status === 'completed' && a.date.startsWith(prefix))
      .reduce((sum, a) => sum + Number(serviceMap.get(a.service_id)?.price ?? 0), 0);
    return { month, revenue };
  });

  const statusCounts: Record<string, number> = {};
  allAppointments.forEach((a) => {
    if (!a.status) return;
    statusCounts[a.status] = (statusCounts[a.status] || 0) + 1;
  });

  const appointmentsByStatus = Object.entries(statusCounts).map(([status, count]) => ({
    status,
    count,
  }));

  const serviceCounts: Record<string, { count: number; revenue: number }> = {};
  allAppointments
    .filter((a) => a.status === 'completed')
    .forEach((a) => {
      const service = serviceMap.get(a.service_id);
      if (service) {
        if (!serviceCounts[service.name]) serviceCounts[service.name] = { count: 0, revenue: 0 };
        serviceCounts[service.name].count += 1;
        serviceCounts[service.name].revenue += Number(service.price);
      }
    });

  const topServices = Object.entries(serviceCounts)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const staffPerf: Record<string, { appointments: number; revenue: number }> = {};
  allAppointments
    .filter((a) => a.status === 'completed')
    .forEach((a) => {
      const member = staffMap.get(a.staff_id);
      const service = serviceMap.get(a.service_id);
      if (member) {
        if (!staffPerf[member.name]) staffPerf[member.name] = { appointments: 0, revenue: 0 };
        staffPerf[member.name].appointments += 1;
        staffPerf[member.name].revenue += Number(service?.price ?? 0);
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

router.get('/reminders', async (_req, res) => {
  const { data, error } = await supabase
    .from('reminders')
    .select(`
      *,
      appointments(
        date,
        start_time,
        clients(name)
      )
    `)
    .order('scheduled_for');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapEnrichedReminder));
});

export default router;
