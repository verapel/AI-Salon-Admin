import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Calendar, DollarSign, CheckCircle, Bell, ArrowRight, Mail, MessageCircle } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { formatCurrency, getStatusColor } from '@/lib/utils';
import type { DashboardStats, Appointment } from '@/types';

const fmt24 = (t: string) => t.slice(0, 5);

export default function Dashboard() {
  const { t } = useLanguage();
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

  const quickActions: { to: string; labelKey: TranslationKey; descKey: TranslationKey }[] = [
    { to: '/bookings', labelKey: 'dashboard.newBooking', descKey: 'dashboard.newBookingDesc' },
    { to: '/clients', labelKey: 'dashboard.addClient', descKey: 'dashboard.addClientDesc' },
    { to: '/reminders', labelKey: 'dashboard.viewReminders', descKey: 'dashboard.viewRemindersDesc' },
    { to: '/statistics', labelKey: 'dashboard.viewAnalytics', descKey: 'dashboard.viewAnalyticsDesc' },
  ];

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard title={t('dashboard.totalClients')} value={stats?.totalClients ?? 0} icon={Users} color="blue" trend={t('dashboard.trendClients')} trendUp />
        <StatCard title={t('dashboard.todayAppointments')} value={stats?.todayAppointments ?? 0} icon={Calendar} color="brand" />
        <StatCard title={t('dashboard.monthlyRevenue')} value={formatCurrency(stats?.monthlyRevenue ?? 0)} icon={DollarSign} color="green" trend={t('dashboard.trendRevenue')} trendUp />
        <StatCard title={t('dashboard.totalAppointments')} value={stats?.totalAppointments ?? 0} icon={Calendar} color="purple" />
        <StatCard title={t('dashboard.completionRate')} value={`${stats?.completionRate ?? 0}%`} icon={CheckCircle} color="green" />
        <StatCard title={t('dashboard.pendingReminders')} value={stats?.upcomingReminders ?? 0} icon={Bell} color="orange" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">{t('dashboard.todaySchedule')}</h3>
            <Link to="/calendar" className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
              {t('dashboard.viewCalendar')} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {appointments.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">{t('dashboard.noAppointments')}</p>
          ) : (
            <div className="space-y-3">
              {appointments.map((apt) => (
                <div
                  key={apt.id}
                  className="flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-gray-50 sm:gap-4 sm:p-4 dark:hover:bg-gray-800/50"
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                    <span className="text-sm font-bold tabular-nums">{fmt24(apt.startTime)}</span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium leading-tight text-gray-900 dark:text-white">
                        {apt.clientName}
                      </p>
                      <span className={`badge shrink-0 text-xs ${getStatusColor(apt.status)}`}>
                        {apt.status}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {apt.serviceName}
                      {apt.staffName ? ` · ${apt.staffName}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="card">
            <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">{t('dashboard.quickActions')}</h3>
            <div className="space-y-2">
              {quickActions.map((action) => (
                <Link
                  key={action.to}
                  to={action.to}
                  className="flex min-h-[52px] items-center justify-between gap-3 rounded-lg border p-3.5 transition-colors hover:bg-gray-50 sm:min-h-0 sm:p-3 dark:hover:bg-gray-800/50"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{t(action.labelKey)}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{t(action.descKey)}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-gray-400" />
                </Link>
              ))}
            </div>
          </div>

          <div className="card">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">{t('dashboard.support')}</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('dashboard.supportText')}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <a
                href="mailto:support@aisalon.app?subject=Telegram%20Connection%20Help"
                className="flex min-h-[40px] items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/50"
              >
                <Mail className="h-4 w-4 shrink-0 text-gray-400" />
                {t('dashboard.emailSupport')}
              </a>
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="flex min-h-[40px] items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/50"
              >
                <MessageCircle className="h-4 w-4 shrink-0 text-gray-400" />
                {t('dashboard.botFatherGuide')}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
