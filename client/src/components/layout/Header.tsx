import { useEffect, useRef, useState } from 'react';
import { Menu, Moon, Sun, Bell, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTheme } from '@/context/ThemeContext';
import { api } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/utils';
import type { Reminder } from '@/types';

interface HeaderProps {
  title: string;
  subtitle?: string;
  onMenuClick: () => void;
  actions?: React.ReactNode;
}

export default function Header({ title, subtitle, onMenuClick, actions }: HeaderProps) {
  const { theme, toggleTheme } = useTheme();
  const [panelOpen, setPanelOpen] = useState(false);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  // Два отдельных ref: кнопка bell и сама панель.
  // Оба нужны, чтобы mousedown на bell не триггерил "закрыть", пока click его ещё не обработал.
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const pending = reminders.filter((r) => r.status === 'pending');

  useEffect(() => {
    api.stats.getReminders()
      .then((data) => setReminders(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Закрытие по клику снаружи — добавляем listener только когда панель открыта
  useEffect(() => {
    if (!panelOpen) return;

    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Клик внутри панели или на кнопку bell — не закрываем
      if (panelRef.current?.contains(target) || bellRef.current?.contains(target)) {
        return;
      }
      setPanelOpen(false);
    };

    // Небольшая задержка, чтобы mousedown, который открыл панель, не закрыл её сразу
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handleOutside);
    }, 0);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handleOutside);
    };
  }, [panelOpen]);

  const close = () => setPanelOpen(false);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-white/80 px-4 backdrop-blur-md dark:bg-gray-900/80 sm:px-6">
      <div className="flex items-center gap-3">
        <button onClick={onMenuClick} className="btn-ghost lg:hidden">
          <Menu className="h-5 w-5" />
        </button>
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
          {subtitle && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {actions}

        {/* Кнопка уведомлений */}
        <div className="relative">
          <button
            ref={bellRef}
            onClick={() => setPanelOpen((v) => !v)}
            className="btn-ghost relative"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5" />
            {!loading && pending.length > 0 && (
              <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand-500 text-[9px] font-bold text-white">
                {pending.length > 9 ? '9+' : pending.length}
              </span>
            )}
          </button>

          {panelOpen && (
            <div
              ref={panelRef}
              className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
            >
              {/* Заголовок */}
              <div className="flex items-center justify-between border-b px-4 py-3 dark:border-gray-700">
                <div>
                  <h3 className="font-semibold text-gray-900 dark:text-white">Reminders</h3>
                  {!loading && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {pending.length} pending
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={close}
                  className="btn-ghost p-1 text-gray-400"
                  aria-label="Close notifications"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Тело */}
              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                </div>
              ) : pending.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No pending reminders
                </p>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto dark:divide-gray-700">
                  {pending.slice(0, 15).map((r) => (
                    <li key={r.id} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {r.clientName}
                      </p>
                      {r.appointmentDate && (
                        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                          {formatDate(r.appointmentDate)}
                          {r.appointmentTime ? ` at ${formatTime(r.appointmentTime)}` : ''}
                        </p>
                      )}
                      <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">
                        {r.message}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {/* Ссылка на полную страницу */}
              <div className="border-t px-4 py-2.5 dark:border-gray-700">
                <Link
                  to="/reminders"
                  onClick={close}
                  className="text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
                >
                  View all reminders →
                </Link>
              </div>
            </div>
          )}
        </div>

        <button onClick={toggleTheme} className="btn-ghost" aria-label="Toggle theme">
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
        <div className="ml-2 hidden items-center gap-2 sm:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
            AD
          </div>
        </div>
      </div>
    </header>
  );
}
