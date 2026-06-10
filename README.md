# Learn Now API (TOEIC Practice Backend)

Express + Prisma (SQLite) API for the TOEIC practice frontend.

## Prerequisites

- Node.js 20+
- `ALIBABA_API_KEY` (Alibaba Model Studio / Qwen) and/or `OPENAI_API_KEY` / `GEMINI_API_KEY` for admin AI import
- AWS S3 bucket + IAM credentials (required for admin file upload)

## Setup

```bash
npm install
# Chỉnh learn-now-nodejs/.env — set ALIBABA_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY cho admin import

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
| `AI_PROVIDER`          | `auto` (default), `alibaba`, `deepseek`, `openai`, or `gemini` |
| `AI_PROVIDER_ORDER`    | Comma-separated fallback order; default `alibaba,deepseek,openai,gemini` |
| `DEEPSEEK_API_KEY`     | [DeepSeek API](https://api-docs.deepseek.com/) (OpenAI-compatible) |
| `DEEPSEEK_BASE_URL`    | Default `https://api.deepseek.com` |
| `DEEPSEEK_MODEL`       | Default `deepseek-v4-flash`; fallback `deepseek-v4-pro` via `DEEPSEEK_MODEL_FALLBACKS` |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | Default `8192` |
| `ALIBABA_API_KEY`      | Alibaba Cloud Model Studio (Qwen), OpenAI-compatible endpoint |
| `ALIBABA_BASE_URL`     | Workspace compatible-mode URL (from Model Studio console) |
| `ALIBABA_MODEL`        | Default `qwen-plus`; vision: `ALIBABA_VISION_MODEL` (`qwen-vl-plus`) |
| `OPENAI_API_KEY`       | OpenAI for TOEIC import (fallback in `auto`) |
| `OPENAI_MODEL`         | Optional; default `gpt-4o-mini`      |
| `OPENAI_MODEL_FALLBACKS` | Comma-separated; default `gpt-4o,gpt-4.1` |
| `OPENAI_MAX_OUTPUT_TOKENS` | Optional; default `65536`        |
| `GEMINI_API_KEY`       | Google Gemini (fallback in `auto`)   |
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
| `MARKITDOWN_URL`         | MarkItDown sidecar URL (`http://markitdown:8080` in Docker Compose; `http://localhost:8080` if API chạy ngoài Docker). Để trống = chỉ dùng pdf-parse |
| `MARKITDOWN_TIMEOUT_MS`  | Optional; timeout gọi sidecar (default `120000`) |
| `AI_ENABLE_STREAMING`    | `true` (default) — stream JSON; on truncate, handoff partial sang provider kế |
| `HEADROOM_BASE_URL`      | Headroom proxy (`http://headroom:8787` trong Compose; `http://127.0.0.1:8787` nếu API dev + proxy Docker). Để trống hoặc `HEADROOM_ENABLED=false` = tắt nén |
| `HEADROOM_MIN_CHARS`     | Chỉ nén prompt text ≥ N ký tự (default `2000`). Vision (KEY RC ảnh) không nén |
| `ALIBABA_MAX_OUTPUT_TOKENS` | Default `8192` (tránh lỗi Qwen max_tokens) |
| `OPENAI_MAX_OUTPUT_TOKENS`  | Default `16384` |
| `GEMINI_MAX_OUTPUT_TOKENS`  | Default `8192` |

### Import pipeline checkpoint + resume

TOEIC import lưu tiến độ từng bước trong `IngestionDraft.pipelineState` (extract → RC key → Listening 1–4 → Reading 5–7 → save). Khi job `FAILED`, gọi lại chỉ các bước chưa `done` — không parse lại Part đã xong.

```bash
# Tiếp tục job sau khi hết quota AI
POST /api/admin/import-jobs/:jobId/resume
```

Log: `[Pipeline] step=parse_listening_2 status=skip` (đã checkpoint) hoặc `status=run`.

### Docker Compose (API + Postgres + Redis + MarkItDown + Headroom)

```bash
docker compose up -d --build
```

| Service | Port | Mô tả |
|---------|------|--------|
| `api` | 4000 | Node.js API |
| `markitdown` | 8080 | Python sidecar — `POST /convert`, `GET /health` |
| `headroom` | 8787 | Context compression proxy — nén prompt text trước Alibaba/OpenAI |
| `db` | 5432 | PostgreSQL |
| `redis` | 6379 | Redis |

Chỉ chạy sidecar (dev local, API bằng `npm run dev`):

```bash
docker compose up -d markitdown headroom
# .env: MARKITDOWN_URL=http://localhost:8080
# .env: HEADROOM_BASE_URL=http://127.0.0.1:8787
```

Hoặc proxy Headroom riêng: `docker run -d --name headroom -p 8787:8787 ghcr.io/chopratejas/headroom:latest`

Tắt MarkItDown (chỉ pdf-parse): trong `.env` set `MARKITDOWN_URL=` (rỗng) và bỏ `depends_on` markitdown hoặc không start service `markitdown`.


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
