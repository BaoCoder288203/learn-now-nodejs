# Hướng dẫn Deploy Learn Now (Backend + Frontend)

Tài liệu này gom toàn bộ quy trình deploy **backend Node.js** (`learn-now-nodejs`) lên **AWS EC2** với **Docker**, **GitHub Actions CI/CD**, **Nginx**, **HTTPS**, và cấu hình domain cho **frontend React** (`learn-now-reactjs`).

---

## Mục lục

1. [Kiến trúc tổng quan](#1-kiến-trúc-tổng-quan)
2. [Thông tin project thực tế](#2-thông-tin-project-thực-tế)
3. [Điều kiện tiên quyết](#3-điều-kiện-tiên-quyết)
4. [Bước 1 — Chuẩn bị EC2](#bước-1--chuẩn-bị-ec2)
5. [Bước 2 — Clone repo & chạy Docker lần đầu](#bước-2--clone-repo--chạy-docker-lần-đầu)
6. [Bước 3 — Cấu hình biến môi trường (.env)](#bước-3--cấu-hình-biến-môi-trường-env)
7. [Bước 4 — GitHub Actions CI/CD](#bước-4--github-actions-cicd)
8. [Bước 5 — DNS & Domain](#bước-5--dns--domain)
9. [Bước 6 — Nginx reverse proxy](#bước-6--nginx-reverse-proxy)
10. [Bước 7 — HTTPS (SSL) với Certbot](#bước-7--https-ssl-với-certbot)
11. [Bước 8 — Cấu hình Frontend (sau khi BE xong)](#bước-8--cấu-hình-frontend-sau-khi-be-xong)
12. [Checklist production](#checklist-production)
13. [Troubleshooting](#troubleshooting)

---

## 1. Kiến trúc tổng quan

```txt
Local Mac
  └─ git push
       ↓
GitHub Repo (learn-now-nodejs)
       ↓
GitHub Actions (SSH vào EC2)
       ↓
EC2 Ubuntu
  ├─ docker compose
  │   ├─ api         (Node.js 20, port 4000)
  │   ├─ markitdown  (Python MarkItDown sidecar, port 8080)
  │   ├─ db          (PostgreSQL 15)
  │   └─ redis       (Redis 7)
  ├─ Nginx        (reverse proxy 80/443 → localhost:4000)
  └─ Certbot      (SSL Let's Encrypt)

Domain:
  • api.jobsnow.id.vn      → Backend API
  • learnnow.jobsnow.id.vn → Frontend web (bước sau)
```

**Lưu ý quan trọng:** GitHub Actions chỉ **pull code + rebuild Docker**. Nginx, DNS, SSL phải cấu hình **thủ công trên EC2** (một lần).

---

## 2. Thông tin project thực tế

| Mục | Giá trị |
|-----|---------|
| Repo backend | `https://github.com/BaoCoder288203/learn-now-nodejs.git` |
| Repo frontend | `learn-now-reactjs` |
| Entry point | `src/index.ts` → build → `dist/index.js` |
| Port API | **4000** (không phải 3000) |
| Chạy production | `npm run build` → `node dist/index.js` |
| Database | PostgreSQL + Prisma (không dùng MongoDB) |
| Cache | Redis |
| Domain API | `api.jobsnow.id.vn` |
| Domain web | `learnnow.jobsnow.id.vn` |

**Không dùng:**

- `node index.js` (file không tồn tại ở root)
- PM2 (Docker tự restart container)
- MongoDB

---

## 3. Điều kiện tiên quyết

### Trên AWS

- [x] EC2 Ubuntu 22.04
- [x] Security Group mở port **22** (SSH), **80** (HTTP), **443** (HTTPS)
- [ ] **Không** mở port 5432, 6379 ra internet (DB/Redis chỉ internal Docker)

### Trên Mac

- [x] SSH vào EC2 được
- [x] Repo đã push lên GitHub

### Domain

- [x] Sở hữu subdomain `jobsnow.id.vn`
- [x] Tạo A record trỏ về IP EC2

---

## Bước 1 — Chuẩn bị EC2

SSH vào EC2:

```bash
ssh ubuntu@YOUR_EC2_PUBLIC_IP
```

### 1.1 Cài Docker & Git

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker ubuntu
```

Logout SSH rồi login lại, kiểm tra:

```bash
docker --version
docker compose version
```

### 1.2 Tạo thư mục deploy

```bash
sudo mkdir -p /var/www/backend
sudo chown ubuntu:ubuntu /var/www/backend
```

---

## Bước 2 — Clone repo & chạy Docker lần đầu

```bash
cd /var/www/backend
git clone https://github.com/BaoCoder288203/learn-now-nodejs.git
cd learn-now-nodejs
```

### 2.1 Chạy Docker Compose

```bash
docker compose up -d --build
docker compose ps
```

Phải thấy 3 container: `api`, `db`, `redis`.

### 2.2 Test API trên EC2

```bash
curl http://localhost:4000/health
```

Kết quả mong đợi:

```json
{"status":"ok"}
```

### 2.3 Chạy thủ công (không Docker) — chỉ để debug

Nếu cần test ngoài Docker:

```bash
npm install
npm run build
npm start
# hoặc dev: npm run dev
```

**Không** chạy `node index.js` — file không tồn tại.

---

## Bước 3 — Cấu hình biến môi trường (.env)

Tạo file `.env` trên EC2 (không commit vào git):

```bash
nano /var/www/backend/learn-now-nodejs/.env
```

### 3.1 Nội dung mẫu

```env
# App
NODE_ENV=production
PORT=4000
CORS_ORIGIN=https://learnnow.jobsnow.id.vn,http://localhost:5173

# JWT — đổi secret mạnh trên production
JWT_SECRET=your_strong_jwt_secret
JWT_REFRESH_SECRET=your_strong_refresh_secret

# AI import TOEIC — dual provider (OpenAI ưu tiên, Gemini fallback khi 429/quota)
AI_PROVIDER=auto
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
OPENAI_MODEL_FALLBACKS=gpt-4o,gpt-4.1

GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash

# MarkItDown (trong Docker Compose: http://markitdown:8080)
MARKITDOWN_URL=http://markitdown:8080

# Headroom (Compose: http://headroom:8787)
HEADROOM_ENABLED=true
HEADROOM_BASE_URL=http://headroom:8787
ALIBABA_MAX_OUTPUT_TOKENS=8192
OPENAI_MAX_OUTPUT_TOKENS=16384
GEMINI_MAX_OUTPUT_TOKENS=8192

# AWS S3 (bắt buộc nếu dùng upload file)
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=ap-southeast-1
S3_BUCKET_NAME=your-bucket

# SMTP (optional — email forgot password)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email
SMTP_PASS=your_app_password
```

`docker-compose.yml` đọc `CORS_ORIGIN` từ `.env` qua `${CORS_ORIGIN:-...}`. `DATABASE_URL` và `REDIS_URL` đã được cấu hình sẵn trong compose trỏ vào container `db` và `redis`.

### 3.2 Restart sau khi sửa .env

```bash
cd /var/www/backend/learn-now-nodejs
docker compose up -d
```

### 3.3 Biến môi trường quan trọng

| Biến | Mô tả | Ghi chú |
|------|-------|---------|
| `CORS_ORIGIN` | URL frontend được phép gọi API | Phải khớp domain FE |
| `AI_PROVIDER` | `auto` \| `alibaba` \| `deepseek` \| `openai` \| `gemini` | `auto` + `AI_PROVIDER_ORDER` |
| `AI_PROVIDER_ORDER` | Thứ tự fallback | Mặc định `alibaba,deepseek,openai,gemini` |
| `ALIBABA_API_KEY` | Alibaba Model Studio (Qwen) | OpenAI-compatible base URL |
| `DEEPSEEK_API_KEY` | DeepSeek API | Base `https://api.deepseek.com`, model `deepseek-v4-flash` |
| `OPENAI_API_KEY` | OpenAI (fallback) | |
| `GEMINI_API_KEY` | Google Gemini (fallback) | |
| `AI_ENABLE_STREAMING` | Stream JSON, partial handoff | Mặc định bật |
| `MARKITDOWN_URL` | Sidecar chuyển PDF/DOCX → text | Trong Docker: `http://markitdown:8080` |
| `HEADROOM_BASE_URL` | Proxy nén prompt text (Alibaba/OpenAI) | `http://headroom:8787`; tắt: `HEADROOM_ENABLED=false` |
| `ALIBABA_MAX_OUTPUT_TOKENS` | Cap output Qwen | Mặc định `8192` |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | Cap output DeepSeek | Mặc định `8192` |

**Resume import sau FAILED:** `POST /api/admin/import-jobs/:jobId/resume` — chỉ chạy lại các pipeline step chưa `done` (checkpoint trong `IngestionDraft.pipelineState`).
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Ký token | Đổi trên production |
| `AWS_*` / `S3_BUCKET_NAME` | Upload file lên S3 | Admin feature |

---

## Bước 4 — GitHub Actions CI/CD

Mục tiêu: **push code → EC2 tự pull + rebuild Docker**.

### 4.1 Tạo SSH key cho GitHub Actions (trên Mac)

```bash
ssh-keygen -t ed25519 -C "github-actions-learn-now" -f ~/.ssh/github-actions-learn-now
# Enter 2 lần (không passphrase)
```

Copy public key lên EC2:

```bash
ssh-copy-id -i ~/.ssh/github-actions-learn-now.pub ubuntu@YOUR_EC2_IP
```

Lấy private key:

```bash
cat ~/.ssh/github-actions-learn-now
```

### 4.2 GitHub Secrets

Vào **GitHub → learn-now-nodejs → Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Value |
|--------|-------|
| `EC2_HOST` | IP public EC2 (không có `http://`, không port) |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | Toàn bộ private key |
| `APP_DIR` | `/var/www/backend/learn-now-nodejs` |

**Lưu ý tên secret:** workflow hiện tại dùng `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` (không phải `SSH_HOST`).

### 4.3 Workflow file

File: `.github/workflows/deploy.yml`

```yaml
name: Deploy Learn Now API

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Deploy to EC2 via Docker
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            cd ${{ secrets.APP_DIR }}
            git pull origin main
            docker-compose down
            docker-compose up -d --build
            docker-compose ps
            for i in {1..10}; do
              if curl -sf http://localhost:4000/health; then
                break
              fi
              echo "Đang chờ ứng dụng sẵn sàng..."
              sleep 5
            done
            curl -sf http://localhost:4000/health || exit 1
```

### 4.4 Kích hoạt

```bash
git add .
git commit -m "setup github actions deploy"
git push origin main
```

Vào tab **Actions** trên GitHub — pipeline phải **xanh**.

### 4.5 Lỗi thường gặp khi setup CI/CD

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `missing server host` | Secret `EC2_HOST` chưa khai báo | Thêm secret đúng tên |
| `script: cd` (trống) | Secret `APP_DIR` trống | Thêm `APP_DIR` |
| `Permission denied (publickey)` | Private key sai hoặc chưa copy public key lên EC2 | `ssh-copy-id` lại |

---

## Bước 5 — DNS & Domain

### 5.1 A record

Trong DNS provider (nơi quản lý `jobsnow.id.vn`):

| Type | Name | Value |
|------|------|-------|
| A | `api` | IP public EC2 |
| A | `learnnow` | IP host frontend (cùng EC2 hoặc host riêng) |

### 5.2 Kiểm tra DNS

Trên Mac:

```bash
dig api.jobsnow.id.vn +short
```

So với IP EC2:

```bash
# Trên EC2
curl -4 ifconfig.me
```

Hai IP **phải trùng nhau**.

### 5.3 Về `server_name` trong Nginx

- `server_name` **không tự tạo domain** — chỉ nói Nginx dùng config nào khi request tới hostname đó.
- Phải **sở hữu domain** và **trỏ DNS** về EC2 thì domain mới hoạt động.
- Ghi đại tên trong `server_name` mà không trỏ DNS → không có tác dụng.

---

## Bước 6 — Nginx reverse proxy

GitHub Actions **không** cấu hình Nginx. Làm thủ công trên EC2.

### 6.1 Cài Nginx

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 6.2 Tạo config

```bash
sudo nano /etc/nginx/sites-available/learn-now-api
```

Nội dung:

```nginx
server {
    listen 80;
    server_name api.jobsnow.id.vn;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 6.3 Enable site (đúng thứ tự)

**Bước 1:** Tạo file trong `sites-available` (bước 6.2).

**Bước 2:** Xóa symlink hỏng nếu có:

```bash
sudo rm -f /etc/nginx/sites-enabled/api-jobsnow
sudo rm -f /etc/nginx/sites-enabled/learn-now-api
sudo rm -f /etc/nginx/sites-enabled/default
```

**Bước 3:** Tạo symlink:

```bash
sudo ln -s /etc/nginx/sites-available/learn-now-api /etc/nginx/sites-enabled/learn-now-api
```

**Bước 4:** Test và reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Phải thấy: `nginx: configuration file /etc/nginx/nginx.conf test is successful`

### 6.4 Test

Trên EC2:

```bash
curl http://localhost:4000/health
curl -H "Host: api.jobsnow.id.vn" http://127.0.0.1/health
curl http://api.jobsnow.id.vn/health
```

Postman:

```
GET http://api.jobsnow.id.vn/health
```

Kết quả: `200 OK` + `{"status":"ok"}`

---

## Bước 7 — HTTPS (SSL) với Certbot

**Chỉ làm sau khi HTTP OK** (`http://api.jobsnow.id.vn/health` trả JSON).

### 7.1 Cài Certbot

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
certbot --version
```

### 7.2 Cấp SSL

```bash
sudo certbot --nginx -d api.jobsnow.id.vn
```

- Nhập email
- Chọn `Y` đồng ý Terms
- Chọn **Redirect HTTP → HTTPS** (option 2)

### 7.3 Test HTTPS

```bash
curl https://api.jobsnow.id.vn/health
```

Postman:

```
GET https://api.jobsnow.id.vn/health
```

### 7.4 Auto-renew

```bash
sudo certbot renew --dry-run
```

---

## Bước 8 — Cấu hình Frontend (sau khi BE xong)

### 8.1 Biến môi trường Frontend

File `learn-now-reactjs/.env` (production build):

```env
VITE_API_URL=https://api.jobsnow.id.vn
```

Frontend gọi API dạng: `https://api.jobsnow.id.vn` + `/api/tests`, `/api/auth/login`, ...

**Không** thêm `/api` vào cuối `VITE_API_URL` — code đã tự thêm path.

### 8.2 Backend CORS

Trên EC2, file `.env` backend:

```env
CORS_ORIGIN=https://learnnow.jobsnow.id.vn
```

Restart:

```bash
docker compose up -d
```

### 8.3 Build & deploy Frontend

```bash
cd learn-now-reactjs
VITE_API_URL=https://api.jobsnow.id.vn npm run build
```

Serve thư mục `dist/` tại `learnnow.jobsnow.id.vn` (Nginx static hoặc Vercel/Netlify).

**Nginx mẫu cho frontend** (cùng EC2):

```nginx
server {
    listen 80;
    server_name learnnow.jobsnow.id.vn;
    root /var/www/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

SSL:

```bash
sudo certbot --nginx -d learnnow.jobsnow.id.vn
```

### 8.4 Bảng map domain → config

| Domain | Vai trò | Config ở đâu |
|--------|---------|--------------|
| `api.jobsnow.id.vn` | Backend API | Nginx EC2 + Docker port 4000 |
| `learnnow.jobsnow.id.vn` | Frontend | `VITE_API_URL` + Nginx serve `dist/` |
| — | CORS | Backend `.env` → `CORS_ORIGIN=https://learnnow.jobsnow.id.vn` |

---

## Checklist production

### Backend (EC2)

- [ ] `curl http://localhost:4000/health` → `{"status":"ok"}`
- [ ] GitHub Actions deploy xanh sau push `main`
- [ ] DNS `api.jobsnow.id.vn` trỏ đúng IP EC2
- [ ] Nginx config `server_name api.jobsnow.id.vn`
- [ ] `http://api.jobsnow.id.vn/health` OK
- [ ] `https://api.jobsnow.id.vn/health` OK (sau Certbot)
- [ ] Security Group: 22, 80, 443 mở; 5432, 6379 **đóng**
- [ ] `.env` trên EC2 có JWT, Gemini, AWS secrets
- [ ] `CORS_ORIGIN` trỏ đúng frontend URL

### Frontend (bước sau)

- [ ] `VITE_API_URL=https://api.jobsnow.id.vn`
- [ ] Build lại sau khi đổi `VITE_*`
- [ ] DNS `learnnow.jobsnow.id.vn` trỏ đúng host
- [ ] HTTPS cho frontend domain

---

## Troubleshooting

### `node index.js` không chạy

Project dùng TypeScript. Chạy:

```bash
npm run build && npm start
```

Hoặc dùng Docker: `docker compose up -d --build`

### Postman `/health` trả HTML Django 404

Domain đang trỏ tới **server Django khác**, không phải EC2 Node.js.

- Kiểm tra `dig api.jobsnow.id.vn` vs IP EC2
- Sửa A record DNS

### `missing server host` (GitHub Actions)

Secret `EC2_HOST` chưa khai báo hoặc tên sai. Kiểm tra **Repository secrets**.

### `nginx -t` failed: `api-jobsnow` No such file

Symlink trỏ tới file không tồn tại:

```bash
sudo rm -f /etc/nginx/sites-enabled/api-jobsnow
sudo ln -s /etc/nginx/sites-available/learn-now-api /etc/nginx/sites-enabled/learn-now-api
sudo nginx -t
```

**Quy tắc:** tạo file trong `sites-available` **trước**, rồi mới `ln -s`.

### `ln: File exists`

Symlink đã có — không cần tạo lại. Chỉ cần `sudo nginx -t && sudo systemctl reload nginx`.

### `certbot: command not found`

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### HTTPS fail nhưng HTTP OK

- Security Group chưa mở port **443**
- Chạy Certbot sau khi HTTP đã OK

### Push main OK nhưng domain không update

CI/CD chỉ rebuild Docker. Nginx/DNS/SSL **không** tự đổi khi push code.

### Seed accounts (DB trống)

| Role | Email | Password |
|------|-------|----------|
| Student | `user@toeic.com` | `user123` |
| Admin | `admin@toeic.com` | `admin123` |

---

## Luồng deploy hàng ngày

```txt
1. Code trên Mac
2. git push origin main
3. GitHub Actions SSH → git pull → docker compose up -d --build
4. API tự restart trong Docker
5. Test: https://api.jobsnow.id.vn/health
```

Không cần SSH tay mỗi lần deploy (trừ khi sửa `.env`, Nginx, hoặc DNS).

---

## Bảo mật production (khuyến nghị)

- [ ] Đổi password PostgreSQL mặc định trong `docker-compose.yml`
- [ ] Không expose port 5432, 6379 ra internet
- [ ] Không commit `.env` vào git
- [ ] Dùng JWT secret mạnh trên production
- [ ] Giới hạn SSH (port 22) theo IP nếu có thể
