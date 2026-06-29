/**
 * Post-deploy smoke check. Set DEPLOY_URL to your public server root.
 * Example: DEPLOY_URL=https://your-app.onrender.com node scripts/verify-deployment.mjs
 */
const ROOT = (process.env.DEPLOY_URL || '').replace(/\/$/, '');

if (!ROOT) {
  console.error('Set DEPLOY_URL to your deployed server, e.g.:');
  console.error('  DEPLOY_URL=https://your-app.onrender.com node scripts/verify-deployment.mjs');
  process.exit(1);
}

const checks = [];

async function get(path) {
  const url = `${ROOT}${path}`;
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  console.log(`=== Deployment verify @ ${ROOT} ===\n`);

  const health = await get('/api/health');
  if (health.ok && health.json?.database === 'connected') {
    checks.push(['Health + DB', true]);
    console.log('✓ /api/health — database connected');
  } else {
    checks.push(['Health + DB', false]);
    console.error('✗ /api/health failed', health.status, health.json);
  }

  const tg = await get('/api/telegram/status');
  if (tg.json?.connected) {
    checks.push(['Telegram', true]);
    console.log(`✓ Telegram connected (@${tg.json.bot})`);
  } else {
    checks.push(['Telegram', false]);
    console.warn('⚠ Telegram not connected — connect via Integrations after deploy');
  }

  const index = await get('/');
  if (index.ok && typeof index.text === 'string' && index.text.includes('AI Salon')) {
    checks.push(['Frontend', true]);
    console.log('✓ Frontend SPA served');
  } else if (index.ok && index.text?.includes('<!DOCTYPE html') || index.text?.includes('<div id="root"')) {
    checks.push(['Frontend', true]);
    console.log('✓ Frontend index.html served');
  } else {
    checks.push(['Frontend', false]);
    console.error('✗ Frontend not served at /');
  }

  const clients = await get('/api/clients');
  if (clients.ok) {
    checks.push(['API clients', true]);
    console.log('✓ /api/clients responds');
  } else {
    checks.push(['API clients', false]);
    console.error('✗ /api/clients failed');
  }

  console.log('\n=== Summary ===');
  const failed = checks.filter(([, p]) => !p).length;
  checks.forEach(([name, pass]) => console.log(`${pass ? '✓' : '✗'} ${name}`));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
