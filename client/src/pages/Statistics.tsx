import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
} from 'recharts';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { AnalyticsData } from '@/types';

const COLORS = ['#c026d3', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function Statistics() {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.stats.getAnalytics()
      .then(setAnalytics)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (!analytics) return null;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-clip space-y-6 animate-fade-in">

      {/* Ряд 1: Monthly Revenue + Pie Chart */}
      <div className="w-full min-w-0 max-w-full grid gap-6 lg:grid-cols-2">

        {/* Bar Chart: Monthly Revenue */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">Monthly Revenue</h3>
          <div className="overflow-hidden">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={analytics.revenueByMonth} margin={{ left: -10, right: 4 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  className="text-gray-500"
                  interval="preserveStartEnd"
                />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} width={48} />
                <Tooltip
                  formatter={(value: number) => [formatCurrency(value), 'Revenue']}
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                />
                <Bar dataKey="revenue" fill="#c026d3" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pie Chart: Appointments by Status — без label-текстов внутри SVG */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">Appointments by Status</h3>
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
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* Легенда вне SVG — корректно переносится на mobile */}
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
            {analytics.appointmentsByStatus.map((item, i) => (
              <div key={item.status} className="flex items-center gap-1.5">
                <div
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: COLORS[i % COLORS.length] }}
                />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {item.status}: {item.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Ряд 2: Top Services + Staff Performance */}
      <div className="w-full min-w-0 max-w-full grid gap-6 lg:grid-cols-2">

        {/* Top Services */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">Top Services</h3>
          <div className="space-y-3">
            {analytics.topServices.map((service, i) => (
              <div key={service.name} className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-sm font-bold text-brand-600 dark:bg-brand-950/50 dark:text-brand-400">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-gray-900 dark:text-white">{service.name}</p>
                  <p className="text-xs text-gray-500">{service.count} bookings</p>
                </div>
                <span className="shrink-0 font-semibold text-brand-600 dark:text-brand-400">
                  {formatCurrency(service.revenue)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Line Chart: Staff Performance — имена сокращены до первого слова */}
        <div className="card w-full min-w-0 max-w-full p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">Staff Performance</h3>
          <div className="overflow-hidden">
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={analytics.staffPerformance} margin={{ left: -10, right: 4 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(name: string) => name.split(' ')[0]}
                />
                <YAxis tick={{ fontSize: 11 }} width={36} />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    name === 'revenue' ? formatCurrency(value) : value,
                    name === 'revenue' ? 'Revenue' : 'Appointments',
                  ]}
                />
                <Line type="monotone" dataKey="appointments" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="revenue" stroke="#c026d3" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

    </div>
  );
}
