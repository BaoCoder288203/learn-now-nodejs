# Learn Now API (TOEIC Practice Backend)

Express + Prisma (SQLite) API for the TOEIC practice frontend.

## Prerequisites

- Node.js 20+
- `GEMINI_API_KEY` (required for admin AI import)
- AWS S3 bucket + IAM credentials (required for admin file upload)

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
| `AWS_ACCESS_KEY_ID`    | IAM access key for S3                |
| `AWS_SECRET_ACCESS_KEY`| IAM secret key for S3                |
| `AWS_REGION`           | S3 region (e.g. `ap-southeast-1`)    |
| `S3_BUCKET_NAME`       | Target bucket name                   |
| `GEMINI_MODEL`         | Optional; default `gemini-2.5-flash` |
| `GEMINI_MODEL_FALLBACKS` | Comma-separated fallback models when quota/503; default `gemini-2.0-flash,gemini-2.0-flash-lite` |
| `GEMINI_MAX_OUTPUT_TOKENS` | Optional; default `65536`        |
| `AUTO_IMPORT_THRESHOLD`| Optional; min confidence (0–1) to skip admin review; default `0.85` |

### S3 object key layout

Upload paths are derived from `Test.examType` (`TOEIC` → `toeic`, `IELTS` → `ielts`):

| File | Key pattern |
|------|-------------|
| Exam PDF | `exams/{exam}/{testId}/exam.pdf` |
| KEY LC PDF | `answers/{exam}/{testId}/key-lc.pdf` |
| KEY RC PDF | `images/{exam}/{testId}/key-rc.pdf` |
| Listening MP3 | `audio/{exam}/{testId}/listening.mp3` |
| Intake (multi-file job, pre-classify) | `intake/{exam}/{testId}/{timestamp}-{name}{ext}` |

`UploadedFile.filePath` stores the S3 key. Listening audio is served via presigned URLs when loading a test.

Docker Compose passes the four `AWS_*` / `S3_BUCKET_NAME` variables from the host `.env` into the `api` service.

Single multi-file import flow:

1. `POST /api/admin/tests/:testId/import-jobs` with multipart `files[]`
2. Poll `GET /api/admin/import-jobs/:jobId`
3. If `REVIEW_REQUIRED`, submit roles via `POST /api/admin/import-jobs/:jobId/review-submit`

Job statuses: `QUEUED` → `EXTRACTING` → `CLASSIFYING` → (`REVIEW_REQUIRED` | `IMPORTING`) → `DONE` | `FAILED`.

Upload rule for import-jobs: send files in one request with **PDF + MP3 only**.
- At least 2 PDFs (exam + answer key docs)
- At least 1 MP3 (listening audio for Part 1-4)
- If you have image answer sheets, convert them to PDF before uploading.

### E2E checklist (manual)

1. `docker compose up -d` (postgres/sqlite per project, `api`)
2. Admin login → create TOEIC test → select test in import panel
3. Upload in one batch: exam PDF + key PDFs + MP3 audio (Part 1-4)
4. Poll until `REVIEW_REQUIRED` or `DONE`
5. If review: assign roles → Confirm & Import → poll until `DONE`
6. Open test as student: 200 questions, listening audio plays (presigned URL)
7. Check API logs for `jobId` on failures

## Frontend

Point the React app at this API:

- Dev: Vite proxy `/api` → `http://localhost:4000`, or set `VITE_API_URL=http://localhost:4000`
- Prod: set `VITE_API_URL` to your deployed API URL and configure `CORS_ORIGIN`

## Production

```bash
npm run build
NODE_ENV=production npm start
```
.
