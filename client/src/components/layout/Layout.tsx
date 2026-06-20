import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';

const pageTitles: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'Dashboard', subtitle: 'Overview of your salon' },
  '/calendar': { title: 'Calendar', subtitle: 'View and manage appointments' },
  '/clients': { title: 'Clients', subtitle: 'Manage your client database' },
  '/services': { title: 'Services', subtitle: 'Service catalog and pricing' },
  '/staff': { title: 'Staff', subtitle: 'Team members and schedules' },
  '/bookings': { title: 'Bookings', subtitle: 'Create and manage appointments' },
  '/statistics': { title: 'Statistics', subtitle: 'Analytics and insights' },
  '/reminders': { title: 'Reminders', subtitle: 'Automated appointment reminders' },
};

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const page = pageTitles[location.pathname] || { title: 'AI Salon Admin', subtitle: '' };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          title={page.title}
          subtitle={page.subtitle}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
