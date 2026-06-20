# AI Salon Admin

A modern beauty salon management platform built with React, TypeScript, Tailwind CSS, and Node.js.

![AI Salon Admin](https://img.shields.io/badge/React-19-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue) ![Tailwind](https://img.shields.io/badge/Tailwind-3.4-38bdf8) ![Node.js](https://img.shields.io/badge/Node.js-Express-green)

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
| Data     | In-memory store (demo-ready)        |

## Project Structure

```
AI Salon Admin/
├── client/                  # React frontend
│   ├── src/
│   │   ├── components/      # Reusable UI & layout components
│   │   │   ├── layout/      # Sidebar, Header, Layout shell
│   │   │   └── ui/          # StatCard, Modal, SearchInput, etc.
│   │   ├── context/         # Theme context (dark mode)
│   │   ├── lib/             # API client & utility functions
│   │   ├── pages/           # Feature pages (Dashboard, Calendar, etc.)
│   │   └── types/           # TypeScript interfaces
│   └── public/              # Static assets
├── server/                  # Express API backend
│   └── src/
│       ├── data/            # Mock data store
│       ├── routes/          # REST API route handlers
│       └── types.ts         # Shared type definitions
└── package.json             # Root workspace scripts
```

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
# Install all dependencies (root, client, and server)
npm install
cd client && npm install
cd ../server && npm install
cd ..
```

### Development

```bash
# Start both frontend and backend concurrently
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

### Production Build

```bash
npm run build
npm start
```

## API Endpoints

| Method | Endpoint              | Description                |
|--------|-----------------------|----------------------------|
| GET    | `/api/health`         | Health check               |
| GET    | `/api/clients`        | List all clients           |
| POST   | `/api/clients`        | Create a client            |
| GET    | `/api/services`       | List all services          |
| GET    | `/api/staff`          | List all staff             |
| GET    | `/api/appointments`   | List appointments          |
| POST   | `/api/appointments`   | Create a booking           |
| GET    | `/api/stats/dashboard`| Dashboard statistics       |
| GET    | `/api/stats/analytics`| Analytics data for charts  |
| GET    | `/api/stats/reminders`| Appointment reminders      |

## License

MIT
