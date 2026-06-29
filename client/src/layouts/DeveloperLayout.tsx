import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, Building2, Plug, Activity, Sparkles, X } from 'lucide-react';
import Header from '@/components/layout/Header';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';
import { cn } from '@/lib/utils';

const navItems: { to: string; icon: typeof LayoutDashboard; labelKey: TranslationKey; end?: boolean }[] = [
  { to: '/developer', icon: LayoutDashboard, labelKey: 'developer.nav.overview', end: true },
  { to: '/developer/salons', icon: Building2, labelKey: 'developer.nav.salons' },
  { to: '/developer/integrations', icon: Plug, labelKey: 'developer.nav.integrations' },
  { to: '/developer/health', icon: Activity, labelKey: 'developer.nav.health' },
];

const pageKeys: Record<string, { title: TranslationKey; subtitle: TranslationKey }> = {
  '/developer': { title: 'developer.home.title', subtitle: 'developer.home.subtitle' },
  '/developer/salons': { title: 'developer.salons.title', subtitle: 'developer.salons.subtitle' },
  '/developer/integrations': { title: 'developer.integrations.title', subtitle: 'developer.integrations.subtitle' },
  '/developer/health': { title: 'developer.health.title', subtitle: 'developer.health.subtitle' },
};

interface DeveloperSidebarProps {
  open: boolean;
  onClose: () => void;
}

function DeveloperSidebar({ open, onClose }: DeveloperSidebarProps) {
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
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-700">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-900 dark:text-white">{t('developer.brand')}</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('developer.cabinet')}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-4">
          {navItems.map(({ to, icon: Icon, labelKey, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  isActive
                    ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                )
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  );
}

export default function DeveloperLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const { t } = useLanguage();

  const keys = pageKeys[location.pathname] ?? {
    title: 'developer.home.title' as TranslationKey,
    subtitle: 'developer.home.subtitle' as TranslationKey,
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <DeveloperSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          title={t(keys.title)}
          subtitle={t(keys.subtitle)}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
