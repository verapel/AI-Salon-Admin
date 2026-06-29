import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { useLanguage, type LangCode, type TranslationKey } from '@/context/LanguageContext';
import { useTheme } from '@/context/ThemeContext';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { AnalyticsData } from '@/types';

const COLORS = ['#c026d3', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

const LOCALE: Record<LangCode, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  hy: 'hy-AM',
};

function statusLabel(status: string, t: (key: TranslationKey) => string) {
  const key = `appointmentStatus.${status}` as TranslationKey;
  const translated = t(key);
  return translated === key ? status : translated;
}

export default function Statistics() {
  const { language, t } = useLanguage();
  const { theme } = useTheme();
  const locale = LOCALE[language];
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const isDark = theme === 'dark';
  const gridStroke = isDark ? '#374151' : '#e5e7eb';
  const tickFill = isDark ? '#9ca3af' : '#6b7280';
  const tooltipStyle = {
    borderRadius: '8px',
    border: isDark ? '1px solid #374151' : '1px solid #e5e7eb',
    backgroundColor: isDark ? '#1f2937' : '#ffffff',
    color: isDark ? '#f9fafb' : '#111827',
  };

  const loadData = useCallback(() => {
    setError(false);
    api.stats
      .getAnalytics()
      .then(setAnalytics)
      .catch((err) => {
        console.error(err);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const revenueByMonth = useMemo(() => {
    if (!analytics) return [];
    const year = new Date().getFullYear();
    return analytics.revenueByMonth.map((row, i) => ({
      ...row,
      monthLabel: new Date(year, i, 1).toLocaleDateString(locale, { month: 'short' }),
    }));
  }, [analytics, locale]);

  if (loading) return <LoadingSpinner />;

  if (error || !analytics) {
    return (
      <EmptyState
        icon={<BarChart3 className="h-8 w-8 text-gray-400" />}
        title={t('statistics.loadError')}
        description={t('statistics.loadErrorDesc')}
        action={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              loadData();
            }}
            className="btn-primary"
          >
            {t('statistics.retry')}
          </button>
        }
      />
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-6 animate-fade-in">
      <div className="grid w-full min-w-0 max-w-full gap-6 lg:grid-cols-2">
        {/* Monthly Revenue */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">
            {t('statistics.monthlyRevenue')}
          </h3>
          {revenueByMonth.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('statistics.noChartData')}
            </p>
          ) : (
            <div className="overflow-hidden">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={revenueByMonth} margin={{ left: 0, right: 4, top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                  <XAxis
                    dataKey="monthLabel"
                    tick={{ fontSize: 11, fill: tickFill }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: tickFill }}
                    tickFormatter={(v) => `$${v}`}
                    width={52}
                  />
                  <Tooltip
                    formatter={(value: number) => [formatCurrency(value), t('statistics.tooltipRevenue')]}
                    contentStyle={tooltipStyle}
                  />
                  <Bar dataKey="revenue" fill="#c026d3" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Appointments by Status */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">
            {t('statistics.appointmentsByStatus')}
          </h3>
          {analytics.appointmentsByStatus.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('statistics.noChartData')}
            </p>
          ) : (
            <>
              <div className="overflow-hidden">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={analytics.appointmentsByStatus}
                      dataKey="count"
                      nameKey="status"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                    >
                      {analytics.appointmentsByStatus.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        value,
                        statusLabel(name, t),
                      ]}
                      contentStyle={tooltipStyle}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
                {analytics.appointmentsByStatus.map((item, i) => (
                  <div key={item.status} className="flex max-w-full items-center gap-1.5">
                    <div
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: COLORS[i % COLORS.length] }}
                    />
                    <span className="truncate text-xs text-gray-600 dark:text-gray-400">
                      {statusLabel(item.status, t)}: {item.count}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid w-full min-w-0 max-w-full gap-6 lg:grid-cols-2">
        {/* Top Services */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">
            {t('statistics.topServices')}
          </h3>
          {analytics.topServices.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('statistics.noTopServices')}
            </p>
          ) : (
            <div className="space-y-3">
              {analytics.topServices.map((service, i) => (
                <div key={service.name} className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-sm font-bold text-brand-600 dark:bg-brand-950/50 dark:text-brand-400">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-gray-900 dark:text-white">{service.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {service.count} {t('statistics.bookingsCount')}
                    </p>
                  </div>
                  <span className="shrink-0 font-semibold text-brand-600 dark:text-brand-400">
                    {formatCurrency(service.revenue)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Staff Performance */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">
            {t('statistics.staffPerformance')}
          </h3>
          {analytics.staffPerformance.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('statistics.noChartData')}
            </p>
          ) : (
            <>
              <div className="overflow-hidden">
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={analytics.staffPerformance} margin={{ left: 0, right: 4, top: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 11, fill: tickFill }}
                      tickFormatter={(name: string) => name.split(' ')[0]}
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis tick={{ fontSize: 11, fill: tickFill }} width={40} />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        name === 'revenue' ? formatCurrency(value) : value,
                        name === 'revenue'
                          ? t('statistics.tooltipRevenue')
                          : t('statistics.tooltipAppointments'),
                      ]}
                      labelFormatter={(name) => name}
                      contentStyle={tooltipStyle}
                    />
                    <Line
                      type="monotone"
                      dataKey="appointments"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line type="monotone" dataKey="revenue" stroke="#c026d3" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="h-0.5 w-5 shrink-0 bg-blue-500" />
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    {t('statistics.legendAppointments')}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-0.5 w-5 shrink-0" style={{ backgroundColor: '#c026d3' }} />
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    {t('statistics.legendRevenue')}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
