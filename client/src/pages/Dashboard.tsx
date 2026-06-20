import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Calendar, DollarSign, CheckCircle, Bell, ArrowRight } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import { formatCurrency, formatTime, getStatusColor } from '@/lib/utils';
import type { DashboardStats, Appointment } from '@/types';

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.stats.getDashboard(),
      api.appointments.getAll(),
    ])
      .then(([dashboardStats, allAppointments]) => {
        setStats(dashboardStats);
        const today = new Date().toISOString().split('T')[0];
        setAppointments(
          allAppointments
            .filter((a) => a.date === today && a.status !== 'cancelled')
            .sort((a, b) => a.startTime.localeCompare(b.startTime))
        );
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard title="Total Clients" value={stats?.totalClients ?? 0} icon={Users} color="blue" trend="+2 this month" trendUp />
        <StatCard title="Today's Appointments" value={stats?.todayAppointments ?? 0} icon={Calendar} color="brand" />
        <StatCard title="Monthly Revenue" value={formatCurrency(stats?.monthlyRevenue ?? 0)} icon={DollarSign} color="green" trend="+12% vs last month" trendUp />
        <StatCard title="Total Appointments" value={stats?.totalAppointments ?? 0} icon={Calendar} color="purple" />
        <StatCard title="Completion Rate" value={`${stats?.completionRate ?? 0}%`} icon={CheckCircle} color="green" />
        <StatCard title="Pending Reminders" value={stats?.upcomingReminders ?? 0} icon={Bell} color="orange" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Today's Schedule</h3>
            <Link to="/calendar" className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
              View calendar <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {appointments.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">No appointments scheduled for today.</p>
          ) : (
            <div className="space-y-3">
              {appointments.map((apt) => (
                <div
                  key={apt.id}
                  className="flex items-center gap-4 rounded-lg border p-4 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                    <span className="text-xs font-medium">{formatTime(apt.startTime).split(' ')[1]}</span>
                    <span className="text-sm font-bold">{formatTime(apt.startTime).split(' ')[0]}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-gray-900 dark:text-white">{apt.clientName}</p>
                    <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                      {apt.serviceName} with {apt.staffName}
                    </p>
                  </div>
                  <span className={`badge ${getStatusColor(apt.status)}`}>{apt.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">Quick Actions</h3>
          <div className="space-y-2">
            {[
              { to: '/bookings', label: 'New Booking', desc: 'Schedule an appointment' },
              { to: '/clients', label: 'Add Client', desc: 'Register a new client' },
              { to: '/reminders', label: 'View Reminders', desc: 'Check pending reminders' },
              { to: '/statistics', label: 'View Analytics', desc: 'Revenue & performance' },
            ].map((action) => (
              <Link
                key={action.to}
                to={action.to}
                className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{action.label}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{action.desc}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-gray-400" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
