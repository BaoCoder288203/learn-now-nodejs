# Learn Now API (TOEIC Practice Backend)

Express + Prisma (SQLite) API for the TOEIC practice frontend.

## Prerequisites

- Node.js 20+
- `GEMINI_API_KEY` (required only for admin AI import)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — set GEMINI_API_KEY if using admin import

npx prisma db push
npm run dev
```

API runs at **http://localhost:4000** (default).

## Seed accounts (empty database)

| Role    | Email            | Password  |
|---------|------------------|-----------|
| Student | user@toeic.com   | user123   |
| Admin   | admin@toeic.com  | admin123  |

## Scripts

| Command           | Description              |
|-------------------|--------------------------|
| `npm run dev`     | Dev server with hot reload |
| `npm run build`   | Bundle to `dist/index.js` |
| `npm start`       | Run production build     |
| `npm run db:push` | Apply Prisma schema to DB |

## Environment

| Variable               | Description                          |
|------------------------|--------------------------------------|
| `PORT`                 | API port (default `4000`)            |
| `CORS_ORIGIN`          | Comma-separated frontend URLs        |
| `GEMINI_API_KEY`       | Google Gemini for OCR import         |
| `JWT_SECRET`           | Access token signing                 |
| `JWT_REFRESH_SECRET`   | Refresh token signing                |

## Frontend

Point the React app at this API:

- Dev: Vite proxy `/api` → `http://localhost:4000`, or set `VITE_API_URL=http://localhost:4000`
- Prod: set `VITE_API_URL` to your deployed API URL and configure `CORS_ORIGIN`

## Production

```bash
npm run build
NODE_ENV=production npm start
```
