import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { useLanguage, type TranslationKey } from '@/context/LanguageContext';

/** Salon cabinet — page titles for the current salon's admin panel */
const pageKeys: Record<string, { title: TranslationKey; subtitle: TranslationKey }> = {
  '/': { title: 'pages.dashboard.title', subtitle: 'pages.dashboard.subtitle' },
  '/calendar': { title: 'pages.calendar.title', subtitle: 'pages.calendar.subtitle' },
  '/clients': { title: 'pages.clients.title', subtitle: 'pages.clients.subtitle' },
  '/services': { title: 'pages.services.title', subtitle: 'pages.services.subtitle' },
  '/staff': { title: 'pages.staff.title', subtitle: 'pages.staff.subtitle' },
  '/bookings': { title: 'pages.bookings.title', subtitle: 'pages.bookings.subtitle' },
  '/statistics': { title: 'pages.statistics.title', subtitle: 'pages.statistics.subtitle' },
  '/reminders': { title: 'pages.reminders.title', subtitle: 'pages.reminders.subtitle' },
  '/integrations': { title: 'pages.integrations.title', subtitle: 'pages.integrations.subtitle' },
};

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const { t } = useLanguage();

  const keys = pageKeys[location.pathname] ?? {
    title: 'pages.default.title' as TranslationKey,
    subtitle: 'pages.default.subtitle' as TranslationKey,
  };

  const title = t(keys.title);
  const subtitle = keys.subtitle ? t(keys.subtitle) : '';

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          title={title}
          subtitle={subtitle || undefined}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
