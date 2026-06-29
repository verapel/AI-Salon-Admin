/**
 * API smoke test — simulates admin salon flow via REST.
 * Run: node scripts/smoke-test.mjs
 */
const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const ts = Date.now();

function localDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const results = { pass: [], fail: [] };
function pass(name) {
  results.pass.push(name);
  console.log(`✓ ${name}`);
}
function fail(name, err) {
  results.fail.push({ name, err: String(err) });
  console.error(`✗ ${name}:`, err);
}

async function main() {
  console.log('=== Smoke test API @', BASE, '===\n');

  let client, service, staff, appointment, appointment2;
  const today = localDateStr(0);
  const tomorrow = localDateStr(1);

  try {
    client = await req('POST', '/clients', {
      name: `Smoke Client ${ts}`,
      email: `smoke${ts}@test.local`,
      phone: `+1555${String(ts).slice(-7)}`,
      notes: 'smoke-test',
    });
    pass('1. Create client');
  } catch (e) {
    fail('1. Create client', e);
    return finish();
  }

  try {
    service = await req('POST', '/services', {
      name: `Smoke Service ${ts}`,
      description: 'Smoke test service',
      duration: 45,
      price: 99,
      category: 'General',
    });
    pass('2. Create service');
  } catch (e) {
    fail('2. Create service', e);
    return finish();
  }

  try {
    staff = await req('POST', '/staff', {
      name: `Smoke Staff ${ts}`,
      email: `staff${ts}@test.local`,
      phone: '+15550001111',
      role: 'Stylist',
      specialties: ['Hair'],
    });
    pass('3. Create staff');
  } catch (e) {
    fail('3. Create staff', e);
    return finish();
  }

  try {
    appointment = await req('POST', '/appointments', {
      clientId: client.id,
      staffId: staff.id,
      serviceId: service.id,
      date: today,
      startTime: '15:00',
      notes: 'Smoke booking',
    });
    pass('4. Create booking');
  } catch (e) {
    fail('4. Create booking', e);
    return finish();
  }

  try {
    appointment2 = await req('POST', '/appointments', {
      clientId: client.id,
      staffId: staff.id,
      serviceId: service.id,
      date: tomorrow,
      startTime: '11:00',
      notes: 'Smoke cancel target',
    });
    pass('4b. Create second booking (for cancel)');
  } catch (e) {
    fail('4b. Create second booking', e);
  }

  // Visibility checks
  try {
    const all = await req('GET', '/appointments');
    const found = all.find((a) => a.id === appointment.id);
    if (!found) throw new Error('appointment not in list');
    if (found.status !== 'scheduled') throw new Error(`expected scheduled, got ${found.status}`);
    pass('5a. Appointment in GET /appointments (Bookings/Calendar)');
  } catch (e) {
    fail('5a. Appointment visibility', e);
  }

  try {
    const dash = await req('GET', '/stats/dashboard');
    if (dash.todayAppointments < 1) throw new Error(`todayAppointments=${dash.todayAppointments}`);
    pass('5b. Dashboard todayAppointments >= 1');
  } catch (e) {
    fail('5b. Dashboard stats', e);
  }

  try {
    const reminders = await req('GET', '/stats/reminders');
    const rem = reminders.find((r) => r.appointmentId === appointment.id);
    if (!rem) throw new Error('no reminder for appointment');
    if (rem.status !== 'pending') throw new Error(`reminder status ${rem.status}`);
    pass('5c. Reminder created (pending)');
  } catch (e) {
    fail('5c. Reminders', e);
  }

  try {
    const analytics = await req('GET', '/stats/analytics');
    if (!analytics.revenueByMonth) throw new Error('no analytics');
    pass('5d. Statistics analytics loads');
  } catch (e) {
    fail('5d. Statistics', e);
  }

  // Edit booking
  try {
    const edited = await req('PUT', `/appointments/${appointment.id}`, {
      startTime: '16:00',
      notes: 'Smoke edited',
    });
    if (edited.startTime.slice(0, 5) !== '16:00') throw new Error(`time ${edited.startTime}`);
    pass('6. Edit booking (time 16:00)');
  } catch (e) {
    fail('6. Edit booking', e);
  }

  // Confirm
  try {
    const confirmed = await req('PUT', `/appointments/${appointment.id}`, { status: 'confirmed' });
    if (confirmed.status !== 'confirmed') throw new Error(confirmed.status);
    pass('7. Confirm booking');
  } catch (e) {
    fail('7. Confirm booking', e);
  }

  // Complete
  let revenueBefore = 0;
  try {
    revenueBefore = (await req('GET', '/stats/dashboard')).monthlyRevenue;
    const completed = await req('PUT', `/appointments/${appointment.id}`, { status: 'completed' });
    if (completed.status !== 'completed') throw new Error(completed.status);
    const dashAfter = await req('GET', '/stats/dashboard');
    if (dashAfter.monthlyRevenue < revenueBefore + 99) {
      throw new Error(`revenue ${revenueBefore} → ${dashAfter.monthlyRevenue}, expected +99`);
    }
    const analytics = await req('GET', '/stats/analytics');
    const hasCompleted = analytics.appointmentsByStatus.some(
      (s) => s.status === 'completed' && s.count > 0
    );
    if (!hasCompleted) throw new Error('no completed in analytics');
    pass('8. Complete booking + revenue in Dashboard/Statistics');
  } catch (e) {
    fail('8. Complete booking + revenue', e);
  }

  // Cancel second
  if (appointment2) {
    try {
      await req('DELETE', `/appointments/${appointment2.id}`);
      const all = await req('GET', '/appointments');
      const apt2 = all.find((a) => a.id === appointment2.id);
      if (!apt2 || apt2.status !== 'cancelled') throw new Error('not cancelled');
      const todayList = all.filter((a) => a.date === tomorrow && a.status !== 'cancelled');
      if (todayList.some((a) => a.id === appointment2.id)) {
        throw new Error('cancelled still in active filter');
      }
      pass('9. Cancel booking (status cancelled, hidden from Calendar filter)');
      const reminders = await req('GET', '/stats/reminders');
      const apt2Reminder = reminders.find((r) => r.appointmentId === appointment2.id);
      if (apt2Reminder && apt2Reminder.status === 'pending') {
        throw new Error('reminder still pending after cancel');
      }
      pass('9b. Reminder cleared after cancel');
    } catch (e) {
      fail('9. Cancel booking', e);
    }
  }

  // Cleanup soft-deletes (optional - deactivate test entities)
  try {
    await req('DELETE', `/clients/${client.id}`);
  } catch {
    /* clients hard delete */
  }

  finish();
}

function finish() {
  console.log('\n=== Summary ===');
  console.log(`Passed: ${results.pass.length}`);
  console.log(`Failed: ${results.fail.length}`);
  if (results.fail.length) {
    console.log(JSON.stringify(results.fail, null, 2));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
