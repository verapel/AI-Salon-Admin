import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Calendar, DollarSign, CheckCircle, Bell, ArrowRight, Mail, MessageCircle } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import QuickBookingModal from '@/components/bookings/QuickBookingModal';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import { formatCurrency, getStatusColor } from '@/lib/utils';
import type { Appointment, DashboardStats, GoogleReviewCalendarItem } from '@/types';

const fmt24 = (time: string) => time.slice(0, 5);

/** Local YYYY-MM-DD — same helper as Calendar (avoids UTC shift from toISOString). */
const toLocalDateStr = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

type TodayItem = {
  id: string;
  startTime: string;
  title: string;
  subtitle?: string;
  staffName?: string;
  kind: 'appointment' | 'google_review';
  status?: Appointment['status'];
};

function statusLabel(status: Appointment['status'], t: (key: TranslationKey) => string) {
  return t(`appointmentStatus.${status}` as TranslationKey);
}

function appointmentToTodayItem(apt: Appointment): TodayItem {
  return {
    id: apt.id,
    startTime: apt.startTime,
    title: apt.clientName || '—',
    subtitle: apt.serviceName,
    staffName: apt.staffName,
    kind: 'appointment',
    status: apt.status,
  };
}

function reviewToTodayItem(ev: GoogleReviewCalendarItem): TodayItem {
  return {
    id: ev.id,
    startTime: ev.startTime,
    title: ev.title,
    subtitle: undefined,
    staffName: ev.staffName,
    kind: 'google_review',
  };
}

function sortTodayItems(a: TodayItem, b: TodayItem): number {
  const byTime = a.startTime.localeCompare(b.startTime);
  if (byTime !== 0) return byTime;
  return (a.staffName ?? '').localeCompare(b.staffName ?? '');
}

export default function Dashboard() {
  const { t } = useLanguage();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [todayItems, setTodayItems] = useState<TodayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [quickBookingOpen, setQuickBookingOpen] = useState(false);

  const loadData = useCallback(() => {
    setError(false);
    const today = toLocalDateStr();
    Promise.all([
      api.stats.getDashboard(),
      api.appointments.getAll(),
      api.calendar.getGoogleReviewEvents().catch(() => ({ events: [] as GoogleReviewCalendarItem[] })),
    ])
      .then(([dashboardStats, allAppointments, reviewData]) => {
        setStats(dashboardStats);
        const appointments = allAppointments
          .filter((a) => a.date === today && a.status !== 'cancelled')
          .map(appointmentToTodayItem);
        const reviews = (reviewData.events ?? [])
          .filter((ev) => ev.date === today)
          .map(reviewToTodayItem);
        setTodayItems([...appointments, ...reviews].sort(sortTodayItems));
      })
      .catch((err) => {
        console.error(err);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const quickLinks: { to: string; labelKey: TranslationKey; descKey: TranslationKey }[] = [
    { to: '/clients', labelKey: 'dashboard.addClient', descKey: 'dashboard.addClientDesc' },
    { to: '/reminders', labelKey: 'dashboard.viewReminders', descKey: 'dashboard.viewRemindersDesc' },
    { to: '/statistics', labelKey: 'dashboard.viewAnalytics', descKey: 'dashboard.viewAnalyticsDesc' },
  ];

  if (loading) return <LoadingSpinner />;

  if (error) {
    return (
      <EmptyState
        icon={<Calendar className="h-8 w-8 text-gray-400" />}
        title={t('dashboard.loadError')}
        description={t('dashboard.loadErrorDesc')}
        action={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              loadData();
            }}
            className="btn-primary"
          >
            {t('dashboard.retry')}
          </button>
        }
      />
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-6 animate-fade-in">
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          title={t('dashboard.totalClients')}
          value={stats?.totalClients ?? 0}
          icon={Users}
          color="blue"
          trend={t('dashboard.trendClients')}
          trendUp
          to="/clients"
        />
        <StatCard
          title={t('dashboard.todayAppointments')}
          value={stats?.todayAppointments ?? 0}
          icon={Calendar}
          color="brand"
          to="/calendar"
        />
        <StatCard
          title={t('dashboard.monthlyRevenue')}
          value={formatCurrency(stats?.monthlyRevenue ?? 0)}
          icon={DollarSign}
          color="green"
          trend={t('dashboard.trendRevenue')}
          trendUp
          to="/statistics"
        />
        <StatCard
          title={t('dashboard.totalAppointments')}
          value={stats?.totalAppointments ?? 0}
          icon={Calendar}
          color="purple"
          to="/calendar"
        />
        <StatCard
          title={t('dashboard.completionRate')}
          value={`${stats?.completionRate ?? 0}%`}
          icon={CheckCircle}
          color="green"
        />
        <StatCard
          title={t('dashboard.pendingReminders')}
          value={stats?.upcomingReminders ?? 0}
          icon={Bell}
          color="orange"
          to="/reminders"
        />
      </div>

      <div className="grid w-full min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card min-w-0 overflow-hidden lg:col-span-2">
          <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              {t('dashboard.todaySchedule')}
            </h3>
            <Link
              to="/calendar"
              className="relative z-10 flex shrink-0 items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400"
            >
              {t('dashboard.viewCalendar')} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {todayItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('dashboard.noAppointments')}
            </p>
          ) : (
            <div className="max-h-[28rem] space-y-3 overflow-y-auto overflow-x-hidden pr-1">
              {todayItems.map((item) => (
                <div
                  key={`${item.kind}:${item.id}`}
                  className="flex min-w-0 items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-gray-50 sm:gap-4 sm:p-4 dark:border-gray-700 dark:hover:bg-gray-800/50"
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                    <span className="text-sm font-bold tabular-nums">{fmt24(item.startTime)}</span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate font-medium leading-tight text-gray-900 dark:text-white">
                        {item.title}
                      </p>
                      {item.kind === 'google_review' ? (
                        <span className="badge shrink-0 bg-amber-100 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                          {t('calendar.googleNeedsReview')}
                        </span>
                      ) : (
                        <span className={`badge shrink-0 text-xs ${getStatusColor(item.status || 'scheduled')}`}>
                          {statusLabel(item.status || 'scheduled', t)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                      {item.kind === 'google_review'
                        ? [t('calendar.googleSource'), item.staffName].filter(Boolean).join(' · ')
                        : [item.subtitle, item.staffName].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="relative z-10 min-w-0 w-full space-y-4">
          <div className="card min-w-0">
            <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">
              {t('dashboard.quickActions')}
            </h3>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setQuickBookingOpen(true)}
                className="relative z-10 flex min-h-[52px] w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-lg border p-3.5 text-left transition-colors hover:bg-gray-50 sm:min-h-0 sm:p-3 dark:border-gray-700 dark:hover:bg-gray-800/50"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {t('dashboard.newBooking')}
                  </p>
                  <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {t('dashboard.newBookingDesc')}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-gray-400" />
              </button>
              {quickLinks.map((action) => (
                <Link
                  key={action.to}
                  to={action.to}
                  className="relative z-10 flex min-h-[52px] w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-lg border p-3.5 transition-colors hover:bg-gray-50 sm:min-h-0 sm:p-3 dark:border-gray-700 dark:hover:bg-gray-800/50"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {t(action.labelKey)}
                    </p>
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {t(action.descKey)}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-gray-400" />
                </Link>
              ))}
            </div>
          </div>

          <div className="card min-w-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">{t('dashboard.support')}</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('dashboard.supportText')}</p>
            <div className="mt-3 flex flex-col gap-2">
              <a
                href="mailto:support@aisalon.app?subject=Telegram%20Connection%20Help"
                className="relative z-10 flex min-h-[44px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/50"
              >
                <Mail className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="truncate">{t('dashboard.emailSupport')}</span>
              </a>
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="relative z-10 flex min-h-[44px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/50"
              >
                <MessageCircle className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="truncate">{t('dashboard.botFatherGuide')}</span>
              </a>
            </div>
          </div>
        </div>
      </div>

      <QuickBookingModal
        open={quickBookingOpen}
        onClose={() => setQuickBookingOpen(false)}
        onSuccess={loadData}
      />
    </div>
  );
}
