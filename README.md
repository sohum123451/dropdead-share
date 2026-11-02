# DropDead — Self-Destructing File Sharing

DropDead is a privacy-first, self-destructing file sharing platform designed for secure, temporary distribution. Files transfer directly between the client and S3-compatible storage via pre-signed URLs, keeping server memory footprint minimal and eliminating intermediary data interception.

- **Live Production Frontend**: [https://dropdead-share.vercel.app](https://dropdead-share.vercel.app)
- **API Contract Specification**: [`docs/API.md`](docs/API.md)
- **Backend Deployment Guide**: [`docs/DEPLOY.md`](docs/DEPLOY.md)
- **Architecture & Decision Ledger**: [`antigravity.md`](antigravity.md)

---

## Key Features

- **Direct-to-Storage Transfer**: File bytes never traverse the Express API server.
  - Uploads: Client requests pre-signed `PUT` URL -> streams directly to S3 -> finalizes session.
  - Downloads: Client requests pre-signed `GET` URL (60-second validity) -> streams directly from S3.
- **Atomic Quota Decrement**: Download counters decrement atomically using single SQL updates, preventing race conditions under concurrent download attempts.
- **Dual Expiry Mechanisms**:
  - Lazy enforcement on every single request (`expires_at > ? AND remaining_downloads > 0`).
  - Proactive background cleanup worker (`node-cron`) sweeping expired/exhausted objects and abandoned upload sessions.
- **Optional Password Protection**: Strong password hashing via Argon2id with 5-minute cryptographic download grant tokens (HMAC-SHA256) and strict rate-limiting (5 attempts / 15 minutes).
- **Utilitarian & Accessible Interface**:
  - Clean internal-tool design system with tabular numeral countdown tickers.
  - Fully accessible (WCAG AA 4.5:1+ contrast compliance verified via axe-core).
  - Light and Dark mode support through `prefers-color-scheme`.

---

## Architecture Overview

```
                      ┌──────────────────────┐
                      │    React 19 Frontend │
                      │  (Vite + Tailwind)   │
                      └───────┬────────┬─────┘
                              │        │
             1. Pre-signed PUT│        │3. Direct Upload /
             2. Finalize /    │        │   Direct Download
                Info / Grant  │        │
                              ▼        ▼
                      ┌────────┐      ┌───────────────┐
                      │Express │      │  AWS S3 /     │
                      │API     │      │  MinIO Storage│
                      └───┬────┘      └───────────────┘
                          │
                     Metadata DB
                  (SQLite WAL Mode)
```

---

## Project Structure

```
├── backend/                  # Node.js 20 + Express + TypeScript API
│   ├── src/
│   │   ├── config/           # Environment & logger configuration (pino)
│   │   ├── db/               # SQLite database setup (better-sqlite3)
│   │   ├── jobs/             # Background cleanup cron worker
│   │   ├── middleware/       # Error handling, 404, rate limiting
│   │   ├── routes/           # /health, /api/uploads, /api/links
│   │   └── storage/          # AWS S3 / MinIO client & presigned URLs
│   └── tests/                # Vitest integration test suite
├── frontend/                 # React 19 + TypeScript + Vite + Tailwind CSS
│   ├── src/
│   │   ├── pages/            # UploadPage, DownloadPage, NotFoundPage
│   │   └── api.ts            # Typed client with XHR progress & grant handling
│   └── e2e/                  # Playwright end-to-end and screenshot test suites
├── docs/                     # Specifications and deployment guides
│   ├── API.md                # Source-of-truth HTTP API contract
│   ├── DEPLOY.md             # Production backend & infra deployment
│   └── FRONTEND_DEPLOY.md    # Frontend S3/CloudFront & Vercel deployment
├── docker-compose.yml        # Local MinIO S3-compatible storage setup
└── antigravity.md            # Comprehensive project ledger and ADRs
```

---

## Quickstart (Local Development)

### 1. Prerequisites
- Node.js 20+
- Docker & Docker Compose

### 2. Start MinIO Storage
```bash
docker compose up -d
```
MinIO S3 API will be available at `http://localhost:9000` (Console at `http://localhost:9001`).

### 3. Start Backend API
```bash
cd backend
npm install
npm run dev
```
Health check endpoint: `http://localhost:3000/health`

### 4. Start Frontend
```bash
cd frontend
npm install
npm run dev
```
Open `http://localhost:5173` in your browser.

---

## Running Automated Tests

### Backend Integration Tests (Vitest)
```bash
cd backend
npm test
```

### Frontend End-to-End Tests (Playwright)
```bash
cd frontend
npx playwright test e2e/e2e.spec.ts
```

### Visual & Accessibility Suite (Axe + Playwright)
```bash
cd frontend
npx playwright test e2e/screenshots.spec.ts
```
