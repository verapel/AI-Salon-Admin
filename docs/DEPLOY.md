# Production deployment (pilot)

Single-server deployment: Express serves the React app and API on one port.

## Option A — Docker (recommended)

```bash
docker build -t ai-salon-admin .
docker run -d \
  -p 3001:3001 \
  -e SUPABASE_URL=... \
  -e SUPABASE_ANON_KEY=... \
  -e OPENROUTER_API_KEY=... \
  -e TELEGRAM_CHAT_ID=... \
  -e APP_URL=https://your-domain.com \
  --name ai-salon-admin \
  ai-salon-admin
```

Telegram bot token can be set via `TELEGRAM_BOT_TOKEN` **or** connected later through **Integrations** (persisted in database).

## Option B — Node on VPS

```bash
npm install
cd client && npm install && cd ../server && npm install && cd ..
npm run build
cd server && node dist/index.js
```

Use nginx/Caddy as reverse proxy with HTTPS. Set `PORT=3001` and proxy `/` to the Node process.

## Option C — Render / Railway

1. Connect GitHub repo
2. Build command: `npm run build`
3. Start command: `npm run start --prefix server`
4. Set environment variables from `server/.env.example`
5. Ensure `client/dist` is present after build (monorepo build handles this)

## Required environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `SUPABASE_URL` | Yes | |
| `SUPABASE_ANON_KEY` | Yes | |
| `SUPABASE_SERVICE_ROLE_KEY` | Recommended | |
| `OPENROUTER_API_KEY` | Yes for AI chat | Booking via buttons works without AI |
| `TELEGRAM_CHAT_ID` | Recommended | Admin notifications |
| `APP_URL` | Recommended | Public URL |
| `TELEGRAM_BOT_TOKEN` | Optional | Or connect via Integrations UI |

## Post-deploy verification

```bash
DEPLOY_URL=https://your-app.example.com node scripts/verify-deployment.mjs
```

After a Telegram test booking:

```bash
API_BASE=https://your-app.example.com/api node scripts/verify-telegram-sync.mjs --phone +7XXXXXXXXXX
```

## Notes

- Use **one instance** only — Telegram polling does not support multiple replicas.
- Apply Supabase migration `20250622000004_salons_and_integrations.sql` before first connect.
