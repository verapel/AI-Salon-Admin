import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import type { DayHoursEdit, Weekday } from '@/lib/scheduleUi';

interface WeeklyHoursEditorProps {
  days: DayHoursEdit[];
  onChange: (days: DayHoursEdit[]) => void;
  disabled?: boolean;
}

const WEEKDAY_KEYS: Record<Weekday, TranslationKey> = {
  1: 'schedule.weekday.1',
  2: 'schedule.weekday.2',
  3: 'schedule.weekday.3',
  4: 'schedule.weekday.4',
  5: 'schedule.weekday.5',
  6: 'schedule.weekday.6',
  7: 'schedule.weekday.7',
};

export default function WeeklyHoursEditor({ days, onChange, disabled }: WeeklyHoursEditorProps) {
  const { t } = useLanguage();

  const updateDay = (weekday: Weekday, patch: Partial<DayHoursEdit>) => {
    onChange(days.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));
  };

  return (
    <div className="space-y-2">
      {days.map((day) => (
        <div
          key={day.weekday}
          className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700 sm:flex-row sm:items-center sm:gap-3"
        >
          <div className="w-full shrink-0 text-sm font-medium text-gray-900 dark:text-white sm:w-28">
            {t(WEEKDAY_KEYS[day.weekday])}
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              checked={!day.isClosed}
              disabled={disabled}
              onChange={(e) => updateDay(day.weekday, { isClosed: !e.target.checked })}
            />
            {day.isClosed ? t('schedule.closed') : t('schedule.open')}
          </label>

          {!day.isClosed && (
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <input
                type="time"
                className="input-field w-auto"
                value={day.openTime}
                disabled={disabled}
                onChange={(e) => updateDay(day.weekday, { openTime: e.target.value })}
              />
              <span className="text-sm text-gray-400">–</span>
              <input
                type="time"
                className="input-field w-auto"
                value={day.closeTime}
                disabled={disabled}
                onChange={(e) => updateDay(day.weekday, { closeTime: e.target.value })}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
