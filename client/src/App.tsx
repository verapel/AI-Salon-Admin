import { Routes, Route } from 'react-router-dom';
import Layout from '@/components/layout/Layout';
import Dashboard from '@/pages/Dashboard';
import Calendar from '@/pages/Calendar';
import Clients from '@/pages/Clients';
import Services from '@/pages/Services';
import Staff from '@/pages/Staff';
import Bookings from '@/pages/Bookings';
import Statistics from '@/pages/Statistics';
import Reminders from '@/pages/Reminders';
import AIAssistant from '@/pages/AIAssistant';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="clients" element={<Clients />} />
        <Route path="services" element={<Services />} />
        <Route path="staff" element={<Staff />} />
        <Route path="bookings" element={<Bookings />} />
        <Route path="statistics" element={<Statistics />} />
        <Route path="reminders" element={<Reminders />} />
        <Route path="ai-assistant" element={<AIAssistant />} />
      </Route>
    </Routes>
  );
}
