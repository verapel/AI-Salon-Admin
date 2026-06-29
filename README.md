# AI Salon Admin

A modern beauty salon management platform built with React, TypeScript, Tailwind CSS, Node.js, and Supabase.

## Features

- **Dashboard** — Overview with key metrics, today's schedule, and quick actions
- **Calendar** — Weekly calendar view of all appointments
- **Client Management** — Full CRUD for client database
- **Services** — Service catalog with pricing, duration, and categories
- **Staff Management** — Team members with roles and specialties
- **Booking System** — Create, confirm, complete, and cancel appointments
- **Statistics** — Revenue charts, appointment analytics, and staff performance
- **Reminders** — Automated email/SMS appointment reminders
- **Dark Mode** — Toggle between light and dark themes

## Tech Stack

| Layer    | Technology                          |
|----------|-------------------------------------|
| Frontend | React 19, TypeScript, Vite          |
| Styling  | Tailwind CSS 3, Lucide Icons        |
| Charts   | Recharts                            |
| Backend  | Node.js, Express, TypeScript        |
| Database | Supabase (PostgreSQL)               |

## Supabase Setup

### 1. Create your environment file

Copy the example and paste your credentials:

```bash
cp server/.env.example server/.env
```

Edit **`server/.env`** and set:

| Variable | Where to find it |
|----------|------------------|
| `SUPABASE_URL` | Supabase Dashboard → **Project Settings** → **API** → **Project URL** |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → **Project Settings** → **API** → **Publishable (anon) key** |
| `SUPABASE_SERVICE_ROLE_KEY` | *(Optional)* Same page → **service_role** secret key |

> **Note:** The React UI still talks to the Express API — you only need env vars in `server/.env`, not in the client.

### 2. Run database migrations

**Option A — SQL Editor (easiest):**

1. Open Supabase Dashboard → **SQL Editor**
2. Paste the contents of `supabase/full_setup.sql`
3. Click **Run**

**Option B — Individual migration files:**

Run these in order from `supabase/migrations/`:

1. `20250622000001_initial_schema.sql` — tables & indexes
2. `20250622000002_rls_policies.sql` — row-level security
3. `20250622000003_seed_data.sql` — demo data

**Option C — Supabase CLI:**

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 3. Verify connection

```bash
cd server && npm run dev
```

Visit http://localhost:3001/api/health — you should see `"database": "connected"`.

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- A Supabase project with migrations applied

### Installation

```bash
npm install
cd client && npm install
cd ../server && npm install
cd ..
```

### Development

```bash
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## Pilot deployment (first real salon)

See **`docs/DEPLOY.md`** for production setup (Docker / VPS / Render).

After deploy:

```bash
DEPLOY_URL=https://your-domain.com node scripts/verify-deployment.mjs
```

**Checklist:** `docs/PILOT_CHECKLIST.md`  
**Owner guide (RU):** `docs/SALON_OWNER_GUIDE.md`

Salon owners connect Telegram via **Integrations** in the admin sidebar (no developer cabinet required).

## Project Structure

```
AI Salon Admin/
├── client/                  # React frontend (unchanged UI)
├── server/
│   ├── .env.example         # Supabase credentials template
│   └── src/
│       ├── lib/
│       │   ├── supabase.ts  # Supabase client
│       │   └── mappers.ts   # DB ↔ API field mapping
│       └── routes/          # REST handlers (Supabase-backed)
└── supabase/
    ├── full_setup.sql       # One-shot migration + seed
    └── migrations/          # Individual SQL migration files
```

## Database Tables

| Table | Description |
|-------|-------------|
| `clients` | Client profiles, visit history |
| `services` | Service catalog with pricing |
| `staff` | Team members and specialties |
| `appointments` | Bookings with status tracking |
| `reminders` | Automated appointment reminders |

## License

MIT
