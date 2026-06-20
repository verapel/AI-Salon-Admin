import { useEffect, useState } from 'react';
import { Bell, Mail, MessageSquare } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { api } from '@/lib/api';
import { formatDate, formatTime, getStatusColor } from '@/lib/utils';
import type { Reminder } from '@/types';

export default function Reminders() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'sent'>('all');

  useEffect(() => {
    api.stats.getReminders()
      .then(setReminders)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? reminders : reminders.filter((r) => r.status === filter);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex gap-2">
        {(['all', 'pending', 'sent'] as const).map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              filter === status
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {status}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-8 w-8 text-gray-400" />}
          title="No reminders"
          description="Reminders are automatically created when you book appointments."
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((reminder) => (
            <div key={reminder.id} className="card flex items-start gap-4 hover:shadow-card-hover">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                reminder.type === 'email'
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400'
                  : 'bg-green-50 text-green-600 dark:bg-green-950/50 dark:text-green-400'
              }`}>
                {reminder.type === 'email' ? <Mail className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">{reminder.clientName}</p>
                    <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{reminder.message}</p>
                  </div>
                  <span className={`badge shrink-0 ${getStatusColor(reminder.status)}`}>{reminder.status}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
                  {reminder.appointmentDate && (
                    <span>Appointment: {formatDate(reminder.appointmentDate)} at {formatTime(reminder.appointmentTime!)}</span>
                  )}
                  <span>Type: {reminder.type.toUpperCase()}</span>
                  <span>Scheduled: {new Date(reminder.scheduledFor).toLocaleString()}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
