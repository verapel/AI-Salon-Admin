import { Routes, Route, Navigate } from 'react-router-dom';
import StaffPortalLayout from '@/layouts/StaffPortalLayout';
import StaffToday from '@/pages/staff/StaffToday';
import StaffCalendar from '@/pages/staff/StaffCalendar';
import StaffSchedule from '@/pages/staff/StaffSchedule';

export default function StaffPortalShell() {
  return (
    <Routes>
      <Route element={<StaffPortalLayout />}>
        <Route index element={<StaffToday />} />
        <Route path="calendar" element={<StaffCalendar />} />
        <Route path="schedule" element={<StaffSchedule />} />
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Route>
    </Routes>
  );
}
