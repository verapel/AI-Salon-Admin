import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Calendar,
  Users,
  Scissors,
  UserCog,
  CalendarPlus,
  BarChart3,
  Bell,
  Sparkles,
  MessageCircle,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';

const navItems: { to: string; icon: typeof LayoutDashboard; labelKey: TranslationKey }[] = [
  { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { to: '/calendar', icon: Calendar, labelKey: 'nav.calendar' },
  { to: '/clients', icon: Users, labelKey: 'nav.clients' },
  { to: '/services', icon: Scissors, labelKey: 'nav.services' },
  { to: '/staff', icon: UserCog, labelKey: 'nav.staff' },
  { to: '/bookings', icon: CalendarPlus, labelKey: 'nav.bookings' },
  { to: '/statistics', icon: BarChart3, labelKey: 'nav.statistics' },
  { to: '/reminders', icon: Bell, labelKey: 'nav.reminders' },
  { to: '/integrations', icon: MessageCircle, labelKey: 'nav.integrations' },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { t } = useLanguage();

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-white transition-transform duration-300 dark:bg-gray-900 lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-16 items-center justify-between border-b px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-900 dark:text-white">{t('sidebar.brand')}</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('sidebar.adminPanel')}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-4">
          {navItems.map(({ to, icon: Icon, labelKey }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  isActive
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                )
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>

        <div className="border-t p-4">
          <div className="rounded-lg bg-gradient-to-br from-brand-500/10 to-brand-700/10 p-4 dark:from-brand-500/5 dark:to-brand-700/5">
            <p className="text-xs font-medium text-brand-700 dark:text-brand-300">{t('sidebar.proTip')}</p>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              {t('sidebar.proTipText')}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
