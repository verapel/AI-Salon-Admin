/**
 * Verify appointment sync across all admin views after Telegram booking.
 * Usage: node scripts/verify-telegram-sync.mjs --phone +79991234567
 *        API_BASE=https://your-app.com/api node scripts/verify-telegram-sync.mjs --phone ...
 */
const args = process.argv.slice(2);
const phoneIdx = args.indexOf('--phone');
const phone = phoneIdx >= 0 ? args[phoneIdx + 1] : null;
const BASE = process.env.API_BASE || 'http://localhost:3001/api';

if (!phone) {
  console.error('Usage: node scripts/verify-telegram-sync.mjs --phone +79991234567');
  process.exit(1);
}

async function req(path) {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const checks = [];

function ok(name) {
  checks.push({ name, pass: true });
  console.log(`✓ ${name}`);
}

function fail(name, err) {
  checks.push({ name, pass: false, err: String(err) });
  console.error(`✗ ${name}:`, err);
}

async function main() {
  console.log(`=== Verify Telegram sync @ ${BASE} ===`);
  console.log(`Phone: ${phone}\n`);

  let clients, appointments, reminders, dashboard, analytics;

  try {
    clients = await req('/clients');
    const client = clients.find((c) => c.phone === phone || c.phone?.replace(/\s/g, '') === phone.replace(/\s/g, ''));
    if (!client) throw new Error('client not found — complete Telegram booking first');
    ok('Client exists in Bookings/Clients');

    appointments = await req('/appointments');
    const clientAppts = appointments.filter((a) => a.clientId === client.id);
    if (clientAppts.length === 0) throw new Error('no appointments for client');
    const latest = clientAppts.sort((a, b) => `${b.date}${b.startTime}`.localeCompare(`${a.date}${a.startTime}`))[0];
    ok(`Appointment in Bookings (${latest.status}, ${latest.date} ${latest.startTime?.slice(0, 5)})`);

    const today = localDateStr();
    if (latest.date === today && latest.status !== 'cancelled') {
      dashboard = await req('/stats/dashboard');
      const inDash = dashboard.todayAppointments?.some((a) => a.id === latest.id);
      if (!inDash) throw new Error('not in dashboard todayAppointments');
      ok('Appointment visible on Dashboard (today)');
    } else {
      ok('Dashboard skip (appointment not today or cancelled)');
    }

    analytics = await req('/stats/analytics');
    if (!analytics.appointmentsByStatus) throw new Error('no analytics');
    ok('Statistics analytics loads');

    reminders = await req('/stats/reminders');
    const rem = reminders.find((r) => r.appointmentId === latest.id);
    if (!rem && latest.status !== 'cancelled') throw new Error('reminder not found');
    if (rem && latest.status === 'cancelled' && rem.status === 'pending') {
      throw new Error('reminder still pending after cancel');
    }
    ok(rem ? `Reminder exists (${rem.status})` : 'Reminder cleared after cancel');

    const calFilter = appointments.filter((a) => a.date === latest.date && a.status !== 'cancelled');
    if (latest.status !== 'cancelled' && !calFilter.some((a) => a.id === latest.id)) {
      throw new Error('not in calendar active filter');
    }
    ok('Calendar filter consistent');
  } catch (e) {
    fail('Sync verification', e);
  }

  console.log('\n=== Summary ===');
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
