import { Routes, Route } from 'react-router-dom';
import Layout from '@/components/layout/Layout';
import DeveloperLayout from '@/layouts/DeveloperLayout';
import ProtectedSalonRoute from '@/components/auth/ProtectedSalonRoute';
import ProtectedDeveloperRoute from '@/components/auth/ProtectedDeveloperRoute';
import StaffSectionGate from '@/components/auth/StaffSectionGate';
import Dashboard from '@/pages/Dashboard';
import Calendar from '@/pages/Calendar';
import Clients from '@/pages/Clients';
import Services from '@/pages/Services';
import Products from '@/pages/Products';
import Schedule from '@/pages/Schedule';
import Bookings from '@/pages/Bookings';
import Statistics from '@/pages/Statistics';
import Reminders from '@/pages/Reminders';
import StaffAccess from '@/pages/StaffAccess';
import SalonIntegrations from '@/pages/SalonIntegrations';
import SetPassword from '@/pages/SetPassword';
import Login from '@/pages/Login';
import DeveloperHome from '@/pages/developer/DeveloperHome';
import DeveloperSalons from '@/pages/developer/DeveloperSalons';
import DeveloperSubscriptions from '@/pages/developer/DeveloperSubscriptions';
import DeveloperIntegrations from '@/pages/developer/DeveloperIntegrations';
import DeveloperHealth from '@/pages/developer/DeveloperHealth';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/set-password" element={<SetPassword />} />

      {/* Staff portal OR owner staff management (role-split) */}
      <Route path="/staff/*" element={<StaffSectionGate />} />

      {/* Salon cabinet — owner/admin only */}
      <Route element={<ProtectedSalonRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/services" element={<Services />} />
          <Route path="/products" element={<Products />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/bookings" element={<Bookings />} />
          <Route path="/statistics" element={<Statistics />} />
          <Route path="/reminders" element={<Reminders />} />
          <Route path="/staff-access" element={<StaffAccess />} />
          <Route path="/integrations" element={<SalonIntegrations />} />
        </Route>
      </Route>

      {/* Developer cabinet */}
      <Route element={<ProtectedDeveloperRoute />}>
        <Route path="/developer" element={<DeveloperLayout />}>
          <Route index element={<DeveloperHome />} />
          <Route path="salons" element={<DeveloperSalons />} />
          <Route path="subscriptions" element={<DeveloperSubscriptions />} />
          <Route path="integrations" element={<DeveloperIntegrations />} />
          <Route path="health" element={<DeveloperHealth />} />
        </Route>
      </Route>
    </Routes>
  );
}
