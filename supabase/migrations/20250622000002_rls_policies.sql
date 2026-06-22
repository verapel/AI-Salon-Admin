-- AI Salon Admin: Row Level Security policies
-- Allows the anon/service keys to read/write while auth is not yet implemented.
-- Tighten these policies before production.

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on clients"
  ON clients FOR SELECT USING (true);

CREATE POLICY "Allow public insert on clients"
  ON clients FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on clients"
  ON clients FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on clients"
  ON clients FOR DELETE USING (true);

CREATE POLICY "Allow public read on services"
  ON services FOR SELECT USING (true);

CREATE POLICY "Allow public insert on services"
  ON services FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on services"
  ON services FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on services"
  ON services FOR DELETE USING (true);

CREATE POLICY "Allow public read on staff"
  ON staff FOR SELECT USING (true);

CREATE POLICY "Allow public insert on staff"
  ON staff FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on staff"
  ON staff FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on staff"
  ON staff FOR DELETE USING (true);

CREATE POLICY "Allow public read on appointments"
  ON appointments FOR SELECT USING (true);

CREATE POLICY "Allow public insert on appointments"
  ON appointments FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on appointments"
  ON appointments FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on appointments"
  ON appointments FOR DELETE USING (true);

CREATE POLICY "Allow public read on reminders"
  ON reminders FOR SELECT USING (true);

CREATE POLICY "Allow public insert on reminders"
  ON reminders FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on reminders"
  ON reminders FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on reminders"
  ON reminders FOR DELETE USING (true);
