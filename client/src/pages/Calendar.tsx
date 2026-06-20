import { useEffect, useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { api } from '@/lib/api';
import { formatTime, getStatusColor } from '@/lib/utils';
import type { Appointment } from '@/types';

const HOURS = Array.from({ length: 12 }, (_, i) => i + 8);

export default function Calendar() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());

  const weekDays = useMemo(() => {
    const start = new Date(currentDate);
    const day = start.getDay();
    start.setDate(start.getDate() - day);

    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [currentDate]);

  useEffect(() => {
    api.appointments.getAll()
      .then(setAppointments)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const getAppointmentsForDay = (date: Date) => {
    const dateStr = date.toISOString().split('T')[0];
    return appointments.filter((a) => a.date === dateStr && a.status !== 'cancelled');
  };

  const navigateWeek = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction * 7);
    setCurrentDate(newDate);
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => navigateWeek(-1)} className="btn-ghost">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            {weekDays[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </h3>
          <button onClick={() => navigateWeek(1)} className="btn-ghost">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        <button onClick={() => setCurrentDate(new Date())} className="btn-secondary text-xs">
          Today
        </button>
      </div>

      <div className="card overflow-hidden p-0">
        <div className="grid grid-cols-8 border-b">
          <div className="border-r p-3 text-xs font-medium text-gray-500">Time</div>
          {weekDays.map((day) => (
            <div
              key={day.toISOString()}
              className={`border-r p-3 text-center last:border-r-0 ${isToday(day) ? 'bg-brand-50 dark:bg-brand-950/30' : ''}`}
            >
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {day.toLocaleDateString('en-US', { weekday: 'short' })}
              </p>
              <p className={`text-lg font-bold ${isToday(day) ? 'text-brand-600 dark:text-brand-400' : 'text-gray-900 dark:text-white'}`}>
                {day.getDate()}
              </p>
            </div>
          ))}
        </div>

        <div className="max-h-[600px] overflow-y-auto">
          {HOURS.map((hour) => (
            <div key={hour} className="grid grid-cols-8 border-b last:border-b-0">
              <div className="border-r p-3 text-xs text-gray-500">
                {hour > 12 ? `${hour - 12} PM` : `${hour} AM`}
              </div>
              {weekDays.map((day) => {
                const dayAppts = getAppointmentsForDay(day).filter((a) => {
                  const aptHour = parseInt(a.startTime.split(':')[0]);
                  return aptHour === hour;
                });

                return (
                  <div key={day.toISOString() + hour} className="min-h-[60px] border-r p-1 last:border-r-0">
                    {dayAppts.map((apt) => (
                      <div
                        key={apt.id}
                        className={`mb-1 rounded-md p-1.5 text-xs ${getStatusColor(apt.status)}`}
                      >
                        <p className="truncate font-medium">{apt.clientName}</p>
                        <p className="truncate opacity-75">{apt.serviceName}</p>
                        <p className="opacity-60">{formatTime(apt.startTime)}</p>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
