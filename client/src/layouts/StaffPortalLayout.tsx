import { NavLink, Outlet } from 'react-router-dom';
import { CalendarDays, CalendarRange, Clock, LogOut } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const navItems: { to: string; end?: boolean; icon: typeof CalendarDays; labelKey: TranslationKey }[] = [
  { to: '/staff', end: true, icon: CalendarDays, labelKey: 'staffPortal.nav.today' },
  { to: '/staff/calendar', icon: CalendarRange, labelKey: 'staffPortal.nav.calendar' },
  { to: '/staff/schedule', icon: Clock, labelKey: 'staffPortal.nav.schedule' },
];

export default function StaffPortalLayout() {
  const { signOut } = useAuth();
  const { t } = useLanguage();
  const [staffName, setStaffName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.staffPortal
      .getMe()
      .then((me) => {
        if (!cancelled) setStaffName(me.staffName);
      })
      .catch(() => {
        if (!cancelled) setStaffName(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-surface-dark">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-900/95">
        <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-gray-900 dark:text-white">
              {staffName ?? t('common.loading')}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('staffPortal.masterLabel')}</p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">{t('staffPortal.nav.logout')}</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-4 pb-24">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white/95 backdrop-blur dark:border-gray-800 dark:bg-gray-900/95">
        <div className="mx-auto flex max-w-lg items-stretch justify-around px-2 py-2">
          {navItems.map(({ to, end, icon: Icon, labelKey }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[11px] font-medium',
                  isActive
                    ? 'text-brand-700 dark:text-brand-300'
                    : 'text-gray-500 dark:text-gray-400'
                )
              }
            >
              <Icon className="h-5 w-5" />
              <span className="truncate">{t(labelKey)}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[11px] font-medium text-gray-500 dark:text-gray-400 sm:hidden"
          >
            <LogOut className="h-5 w-5" />
            <span className="truncate">{t('staffPortal.nav.logout')}</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
