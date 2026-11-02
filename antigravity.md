# Antigravity Project Blueprint & Decision Ledger

> **Self-Destructing File Sharing Application**  
> **Source of Truth & Architectural Decision Record**  
> *Last Updated: 2026-11-01*

---

## 1. Project Overview & System Philosophy

This system is an end-to-end, privacy-focused, self-destructing file sharing platform designed for secure, temporary file distribution.

### Core Architectural Invariants
1. **Direct-to-Storage Transfer**: File payload bytes **never** traverse the Express API server.
   - Uploads: Client requests pre-signed `PUT` URL from backend, uploads payload directly to S3/MinIO, then calls finalize.
   - Downloads: Client requests pre-signed `GET` URL from backend (valid for 60s), which atomically decrements the download counter and streams payload directly from storage.
2. **Instant Expiry & Destruction**: A link is permanently dead the exact millisecond `remaining_downloads <= 0` OR `now > expires_at`.
3. **Lazy Enforcement + Proactive Cron Sweep**: Correctness is enforced lazily on *every single request* (`expires_at > ? AND remaining_downloads > 0`). Background cron sweeps clean up abandoned or dead storage objects idempotently.
4. **Race-Safe Atomic Decrement**: Decrementing downloads occurs in a single SQL operation:
   ```sql
   UPDATE files 
   SET remaining_downloads = remaining_downloads - 1,
       status = CASE WHEN remaining_downloads - 1 = 0 THEN 'dead' ELSE status END
   WHERE token = ? AND remaining_downloads > 0 AND expires_at > ? AND status = 'active';
   ```
5. **Cryptographic Integrity**:
   - Share tokens: 32+ characters generated via `crypto.randomBytes(24).toString('base64url')` (or 64 hex characters), non-sequential and unguessable.
   - Passwords: Argon2id hashing (`argon2`).
   - Password verification: Issues a short-lived (5-minute) cryptographic grant token (HMAC-SHA256) bound to the link token and client.
6. **Uniform Error Contract**: Every error response matches `{ error: { code, message } }`.

---

## 2. API Contract Summary (`/docs/API.md`)

Full specification is maintained in [`docs/API.md`](file:///c:/Users/manga/OneDrive/Desktop/New%20folder%20(4)/docs/API.md).

### Standard Error Codes
| HTTP Status | Error Code | Description |
|:---|:---|:---|
| `400 Bad Request` | `VALIDATION_ERROR` | Schema validation failed or malformed payload |
| `401 Unauthorized` | `PASSWORD_REQUIRED` | Password or download grant token required |
| `401 Unauthorized` | `WRONG_PASSWORD` | Incorrect password or expired grant token |
| `404 Not Found` | `LINK_NOT_FOUND` | Token does not exist or invalid route |
| `404 Not Found` | `UPLOAD_NOT_FOUND` | Upload session does not exist or expired |
| `410 Gone` | `LINK_EXPIRED` | Expiry timestamp has passed (`now > expires_at`) |
| `410 Gone` | `DOWNLOADS_EXHAUSTED` | Download count reached 0 |
| `413 Payload Too Large` | `FILE_TOO_LARGE` | Declared file size exceeds `MAX_FILE_MB` |
| `429 Too Many Requests` | `RATE_LIMITED` | Exceeded rate limit thresholds |

### Endpoints
- `GET /health` — Service healthcheck (`status: "ok"`, `timestamp: ISOString`).
- `POST /api/uploads/init` — Reserve session, validate limits, create pending DB row, issue 10-minute pre-signed PUT URL.
- `POST /api/uploads/:id/finalize` — Verify object in S3 via `HeadObject`, verify size, flip to `active`, hash password, generate token, return share link.
- `GET /api/links/:token/info` — Lazy-check expiry, return metadata only (`filename`, `fileSize`, `contentType`, `isPasswordProtected`, `expiresAt`, `remainingDownloads`).
- `POST /api/links/:token/verify` — Validate password against Argon2 hash, return signed 5-minute `downloadGrantToken`. Rate limited (5 attempts / 15 min).
- `POST /api/links/:token/download` — Check password/grant token, execute atomic decrement, return 60-second pre-signed GET URL with `ResponseContentDisposition: attachment; filename="..."`.

---

## 3. Master Implementation Roadmap

### Phase 0: Shared Contract & Specification
- [x] **Prompt 0**: Lock API specification in `/docs/API.md` (complete error taxonomy, request/response bodies, status codes).

### Phase 1: Backend Implementation (`/backend`)
- [x] **Prompt B1: Scaffold + Storage + Database**
  - [x] Node.js 20 + Express + TypeScript setup.
  - [x] S3 client setup with AWS SDK v3 supporting MinIO & real AWS S3 via environment variables.
  - [x] SQLite metadata table `files` via `better-sqlite3` with WAL mode.
  - [x] Centralized error handler returning uniform error shape.
  - [x] Structured logger via `pino` and `pino-http`.
  - [x] Local Docker Compose running MinIO (`file_share_minio`) on port 9000 & console 9001.
  - [x] Verification: Server boots and `GET /health` returns `{ "status": "ok" }`.
- [x] **Prompt B2: Upload Flow**
  - [x] Implement `POST /api/uploads/init` (Zod validation, limit clamping, pending row creation, UUID S3 key, pre-signed PUT URL).
  - [x] Implement `POST /api/uploads/:id/finalize` (`HeadObjectCommand` verification, size check, status transition to `active`, Argon2 password hash, `base64url` token generation).
  - [x] Integration tests (`vitest` + `supertest`) against running MinIO container.
- [x] **Prompt B3: Download & Atomic Expiry Logic**
  - [x] Implement `GET /api/links/:token/info` (lazy expiry check, no file URL leakage).
  - [x] Implement `POST /api/links/:token/verify` (Argon2 check, HMAC download grant token, rate limiting).
  - [x] Implement `POST /api/links/:token/download` (atomic SQL decrement, 60s pre-signed GET URL, immediate 'dead' marking on 0 remaining).
  - [x] Concurrency test: Fire 20 parallel download requests at `max_downloads=3` and assert exactly 3 succeed.
- [x] **Prompt B4: Background Cleanup Worker**
  - [x] `node-cron` sweep job (every 5 minutes or configured interval).
  - [x] Find expired, exhausted, or abandoned pending uploads (> 1 hour).
  - [x] Delete S3 object first, then tombstone/delete DB row only upon S3 deletion confirmation.
  - [x] Automated test verifying S3 object deletion after expiry sweep.
- [x] **Prompt B5: Production Dockerfile & Deployment Docs**
  - [x] Multi-stage `Dockerfile` (non-root user, slim base, production dependencies only).
  - [x] Write `/docs/DEPLOY.md` for EC2, Nginx, HTTPS, IAM least-privilege policies, and S3 CORS rules.

### Phase 2: Frontend Implementation (`/frontend`)
- [x] **Prompt F1: Scaffold + Typed API Client**
  - [x] React 19 + Vite + TypeScript + Tailwind CSS + React Router.
  - [x] Typed `src/api.ts` mapping error codes to typed `ApiError` class.
- [x] **Prompt F2: Upload Interface**
  - [x] Drag-and-drop file selector, size preview, expiry selector presets + custom, max downloads input.
  - [x] Optional password field with reveal toggle.
  - [x] XHR upload to pre-signed PUT URL with progress events (`upload.onprogress`), cancellation (`abort()`), and retry.
- [x] **Prompt F3: Share Link & QR Result Screen**
  - [x] Share link display with copy button & visual confirmation.
  - [x] Expiry timestamp in local time, remaining download count summary.
  - [x] QR code generator and "Share another file" reset flow.
- [x] **Prompt F4: Recipient Portal (`/d/:token`)**
  - [x] Metadata fetch on load (`/info`).
  - [x] State machines: Loading, Ready (countdown timer, downloads count), Password Gate (rate limit lockout feedback), 404 Not Found, 410 Expired, 410 Exhausted.
  - [x] Direct trigger of browser download via pre-signed GET URL.
- [x] **Prompt F5: Polish & Static Hosting Guide**
  - [x] Error boundaries, 404 route, mobile layout checks at 375px.
  - [x] Write `/docs/FRONTEND_DEPLOY.md` for S3 + CloudFront SPA routing.

### Phase 3: Final System Integration
- [x] **Final Integration**: Run full stack via Docker Compose.
- [x] Playwright end-to-end automated test suite:
  1. [x] 20 MB file upload, download, and SHA-256 byte-for-byte integrity verification.
  2. [x] `max_downloads=1` link exhaustion assertion.
  3. [x] 1-minute expiry portal countdown and cron object sweep.
  4. [x] Password protection verification (rejection on wrong password, success on correct).
  5. [x] Non-existent token 404 test.

### Phase 4: Production Vercel Launch & Cloud Deployment
- [x] **Vercel Project Setup**: Linked `dropdead-share` under `trps-urgewave` (`prj_vOQ0vD6pWIpiL7UOgq20MCe5LC5c`).
- [x] **SPA Routing**: Added `frontend/vercel.json` with `/(.*) -> /index.html` rewrites.
- [x] **Runtime Compatibility**: Set project Node version to `24.x` and used `installCommand: npm install --legacy-peer-deps`.
- [x] **Dynamic Endpoint Switcher**: Implemented live API configuration modal in `Navbar.tsx` and `src/api.ts`.
- [x] **Public Production Alias**: Assigned and verified [`https://dropdead-share.vercel.app`](https://dropdead-share.vercel.app).
- [x] **SSO Protection**: Disabled team SSO gate for unrestricted public access.

---

## 4. Architectural Decision Records (ADRs)

### ADR-001: Direct-to-Storage Upload & Download via Pre-signed URLs
- **Status**: Accepted
- **Context**: Passing large files through the Node.js API server creates CPU and memory bottlenecks, complicates scaling, and exposes file payload data to server memory.
- **Decision**: All payload transfers go directly between the browser and S3/MinIO. The API server only orchestrates metadata, verifies object existence via `HeadObjectCommand`, and generates pre-signed URLs.

### ADR-002: SQLite WAL Mode for High-Performance Concurrency
- **Status**: Accepted
- **Context**: The application requires low-latency, zero-configuration local metadata storage without needing a separate PostgreSQL container during initial setup.
- **Decision**: SQLite via `better-sqlite3` with `PRAGMA journal_mode = WAL` enabled. WAL mode allows concurrent readers alongside a writer, providing high throughput for concurrent download attempts.

### ADR-003: Atomic Decrement at Pre-signed Download URL Issuance
- **Status**: Accepted
- **Context**: Preventing race conditions when multiple users download a file with limited download quotas (`max_downloads`).
- **Decision**: Decrement remaining downloads in a single atomic SQL `UPDATE` statement before issuing the pre-signed GET URL.
- **Trade-off**: If a client receives a pre-signed URL but aborts the download mid-stream, that download attempt is still consumed. This is an intentional security tradeoff to prevent race conditions and guarantee that quota limits cannot be exceeded.

### ADR-004: Password Security via Argon2 & HMAC Download Grant Tokens
- **Status**: Accepted
- **Context**: Protecting shared files with optional passwords without storing plaintext passwords or keeping session state in memory.
- **Decision**: Use Argon2id for password hashing. When `/api/links/:token/verify` succeeds, generate an HMAC-SHA256 download grant token containing `{ token, expiresAt, nonce }` valid for 5 minutes. The recipient submits this token with `/download`.

### ADR-005: Local Runtime Environment Isolation (Node 20 vs Global Node 26)
- **Status**: Accepted
- **Context**: Native C++ addons (`better-sqlite3`, `argon2`) require specific Node ABI versions. The project repository includes a standalone Node 20.18.3 binary in `.tools/node-v20.18.3-win-x64` (ABI 115), whereas the host machine has Node 26.8.1 (ABI 147).
- **Decision**: All local backend commands, test runners, and process launches must prioritize `.tools/node-v20.18.3-win-x64` in `$env:PATH` to guarantee binary compatibility and match production Node 20 LTS.

### ADR-006: Zod Schema Resiliency for Environment Variables
- **Status**: Accepted
- **Context**: In Vitest / Vite environments, `process.env.BASE_URL` is automatically populated as `"/"`, which breaks strict `z.string().url()` validation during test runs.
- **Decision**: Sanitized `BASE_URL` in `src/config/env.ts` with a preprocessor to gracefully map non-URL strings or empty values to `http://localhost:3000`.

### ADR-007: Grace Period for S3 Deletion on Final Download Exhaustion
- **Status**: Accepted
- **Context**: When the remaining download count drops to 0, immediate synchronous S3 object deletion breaks the current recipient's download with a 404 before bytes finish streaming.
- **Decision**: Mark database status `'dead'` synchronously (preventing any subsequent requests), while deferring storage object deletion by 65 seconds (`setTimeout(..., 65000).unref()`) to allow the 60-second pre-signed URL window to finish transmitting safely.

### ADR-008: XMLHttpRequest Streaming Direct-to-S3 with Abort Cancellation
- **Status**: Accepted
- **Context**: Modern `fetch` API does not expose upload progress events, preventing live upload percentage meters.
- **Decision**: Use `XMLHttpRequest` with `xhr.upload.onprogress` for direct-to-S3 pre-signed `PUT` uploads, exposing a cancellation token (`cancelRef.abort()`) to terminate mid-flight transfers.

### ADR-009: Client-Side Countdown Ticker with Lazy State Transition
- **Status**: Accepted
- **Context**: Recipient portal must transition to expired state as soon as `expires_at` is reached without requiring a manual page refresh.
- **Decision**: Drive a 1-second interval timer in `DownloadPage.tsx` computing remaining milliseconds against `expiresAt`. When time reaches 0, atomically flip component state to `expired`.

### ADR-010: Vercel SPA Routing, Cross-Platform Node 24.x Alignment & Dynamic API Switcher
- **Status**: Accepted
- **Context**: Deploying frontend to Vercel requires client-side deep routing (`/d/:token`), cross-platform node compatibility, and seamless backend connectivity across environments.
- **Decision**:
  1. Add `frontend/vercel.json` with SPA rewrite rule `/(.*) -> /index.html`.
  2. Pin project setting `--node-version 24.x` to align with Vercel's supported production Node runtimes.
  3. Strip host-specific `@rolldown/binding-win32-x64-msvc` dependency for clean Linux builds.
  4. Embed dynamic endpoint switcher in `Navbar.tsx` and `src/api.ts` with `localStorage` persistence, enabling user connection to any backend URL (tunnel, cloud EC2, local) from the live Vercel domain.

### ADR-011: Utilitarian Internal-Tool UI Design System
- **Status**: Accepted
- **Context**: The frontend UI had an over-embellished "generic AI" appearance with heavy drop shadows, glows, gradients, pill badges, and marketing jargon. A calm, utilitarian design language is required where the system's rules are the interface.
- **Decision**: Adopt a disciplined, restrained design system defined in a single source of truth:
  1. **Philosophy**: Utilitarian, quiet internal tool; the interface explains system mechanics plainly with zero decorative decoration.
  2. **Color (Light)**: Canvas `#fbfbfa`, panel surface `#ffffff`, hairline borders `#e4e4e7`, primary text `#18181b`, secondary text `#71717a`.
  3. **Color (Dark)**: Canvas `#121212`, panel surface `#181818`, hairline borders `#27272a`, primary text `#f4f4f5`, secondary text `#a1a1aa`.
  4. **Accent**: Single restrained red (`#b91c1c` in light mode, `#ef4444` in dark mode) reserved strictly for primary buttons and critical destructive actions.
  5. **Typography**: Single sans typeface (`IBM Plex Sans` + system sans fallbacks) for all labels, body copy, and headings.
  6. **Monospace Discipline**: Monospace (`IBM Plex Mono` / `SF Mono` / `ui-monospace`) used exclusively for share URLs and countdown digits with `tabular-nums`.
  7. **Type Scale**: Four fixed sizes: Micro 12px (line 16px), Body 14px (line 20px), Medium 16px (line 24px), Title 20px (line 28px); regular (400) and medium (500) weights only.
  8. **Radii & Elevation**: Strict maximum radius of 6px (`4px` for buttons/inputs, `6px` for cards/panels); zero drop shadows, only 1px borders.
  9. **Spacing Scale**: 4px modular scale (`4px`, `8px`, `12px`, `16px`, `24px`, `32px`, `48px`); max content width `560px` left-aligned.
  10. **Accessibility & States**: High-visibility focus indicator (`outline: 2px solid var(--accent); outline-offset: 2px`), minimum 4.5:1 text contrast, responsive at 375px.

---

## 5. Environment & Directory Map

```
├── .tools/
│   └── node-v20.18.3-win-x64/   # Bundled Node.js 20.18.3 LTS runtime & npm
├── backend/
│   ├── data/                    # SQLite database storage (metadata.db)
│   ├── src/
│   │   ├── config/              # Environment config (env.ts) and logger (logger.ts)
│   │   ├── db/                  # SQLite database connection & schema (sqlite.ts)
│   │   ├── errors/              # Uniform AppError taxonomy (app-error.ts)
│   │   ├── middleware/          # Pino HTTP logger, 404 handler, error handler
│   │   ├── routes/              # Express route controllers (health.ts, uploads, links)
│   │   ├── storage/             # S3 / MinIO client & pre-signing helpers (s3.ts)
│   │   ├── app.ts               # Express app factory
│   │   └── index.ts             # Server entry point & graceful shutdown
│   ├── test/                    # Integration & unit test suites (Vitest + Supertest)
│   ├── .env                     # Local environment configuration
│   ├── package.json             # Dependencies and build scripts
│   └── tsconfig.json            # TypeScript configuration
├── docs/
│   ├── API.md                   # Locked HTTP API contract specification
│   ├── DEPLOY.md                # Production backend deployment guide (EC2, S3, Nginx)
│   └── FRONTEND_DEPLOY.md       # Production frontend deployment guide (S3, CloudFront)
├── docker-compose.yml           # MinIO + Bucket auto-provisioning service
└── antigravity.md               # Master system blueprint, decision record & state log
```

---

## 6. Operational Runbook (Quick Commands)

All commands should be executed in PowerShell.

### 1. Ensure MinIO Storage is Running
```powershell
docker compose up -d
# MinIO S3 API: http://localhost:9000
# MinIO Web Console: http://localhost:9001 (minioadmin / minioadmin)
```

### 2. Set Up Node 20 PATH for Backend
```powershell
$env:PATH = "$PWD\.tools\node-v20.18.3-win-x64;" + $env:PATH
```

### 3. Run Backend Integration Tests
```powershell
$env:PATH = "$PWD\.tools\node-v20.18.3-win-x64;" + $env:PATH
cd backend
npx vitest run
```

### 4. Start Backend Server
```powershell
$env:PATH = "$PWD\.tools\node-v20.18.3-win-x64;" + $env:PATH
cd backend
npm run dev
```

### 5. Verify Health Endpoint
```powershell
Invoke-RestMethod -Uri http://localhost:3000/health | ConvertTo-Json
```

---

## 7. Decision & Activity Log

### 2026-11-01 10:35 — Phase 0: Contract Formalization (`/docs/API.md`)
- **Action**: Created `/docs/API.md` defining the exact API specification.
- **Decisions**: Fixed error payload format `{ error: { code, message } }`, error code enum, direct pre-signed URL workflow, atomic download decrement mechanism.

### 2026-11-01 10:40 — Prompt B1: Backend Scaffolding & Verification
- **Action**: Built Express + TypeScript + SQLite + S3 backend skeleton.
- **Fixes Applied**:
  1. Installed `vite` as devDependency to resolve Vitest v5 peer requirement.
  2. Discovered host Node 26.8.1 ABI mismatch with precompiled `better-sqlite3` and `argon2` modules. Identified pre-bundled Node 20.18.3 at `.tools/node-v20.18.3-win-x64`. Configured runtime to use bundled Node 20.
  3. Handled Vite's default `process.env.BASE_URL = "/"` injection in `env.ts` to prevent test-time validation failures.
- **Verification Result**:
  - `npx vitest run`: 2 passed (health check and 404 error contract).
  - Server booted on port 3000 against MinIO (`file_share_minio` container).
  - `GET /health` returned:
    ```json
    {
      "status": "ok",
      "timestamp": "2026-11-01T05:13:16.160Z"
    }
    ```

### 2026-11-01 10:48 — Prompt B2: Upload Flow Implementation & Verification
- **Action**: Implemented `POST /api/uploads/init` and `POST /api/uploads/:id/finalize`.
- **Decisions**:
  - Bound `ContentType` and `ContentLength` into 10-minute pre-signed PUT URL signature.
  - Enforced `MAX_FILE_MB` with 413 `FILE_TOO_LARGE`.
  - Used `crypto.randomUUID()` for S3 key; never exposed client filenames in storage paths.
  - S3 `HeadObjectCommand` verification of existence and size in `finalize`.
  - Treated pending rows older than 1 hour as abandoned.
- **Verification Result**:
  - `tests/uploads.integration.test.ts`: 12 passed against real MinIO container.

### 2026-11-01 10:54 — Prompt B3: Download & Atomic Expiry Logic
- **Action**: Implemented `GET /api/links/:token/info`, `POST /api/links/:token/verify`, and `POST /api/links/:token/download`.
- **Decisions**:
  - Expiry lazily enforced on every request (`now > expires_at`).
  - Atomic single-statement SQL decrement:
    `UPDATE files SET remaining_downloads = remaining_downloads - 1, status = CASE WHEN remaining_downloads - 1 <= 0 THEN 'dead' ELSE status END WHERE token = ? AND remaining_downloads > 0 AND expires_at > ? AND status = 'active'`
  - Password protection via Argon2 + HMAC-SHA256 download grant token (5 min validity) bound to token.
  - Rate limiting on `/verify`: 5 failed attempts per 15 min per IP+token via `express-rate-limit`.
  - S3 object immediately purged when download count hits 0.
- **Verification Result**:
  - `tests/downloads.integration.test.ts`: 11 passed.
  - **Concurrency Test Verified**: 20 parallel download requests against `max_downloads=3` link — **exactly 3 succeeded (HTTP 200)**, **17 failed with 410 DOWNLOADS_EXHAUSTED**, and S3 object was immediately deleted.

### 2026-11-01 10:57 — Prompt B4 & B5: Cleanup Sweep & Production Docker/Deploy
- **Action**:
  - Created `node-cron` worker in `src/jobs/cleanup.ts` running every 5 minutes (`CLEANUP_CRON_SCHEDULE`).
  - Idempotent sweep: deletes S3 object first, deletes DB record only upon S3 deletion confirmation, safe against overlapping runs.
  - Built multi-stage `backend/Dockerfile` with non-root user (`appuser:10001`) and curl healthcheck.
  - Created [`docs/DEPLOY.md`](file:///c:/Users/manga/OneDrive/Desktop/New%20folder%20(4)/docs/DEPLOY.md) with complete EC2, Nginx HTTPS (Certbot), S3 CORS, and least-privilege IAM policy.
- **Verification Result**:
  - `tests/cleanup.integration.test.ts`: 2 passed (expired object sweep and abandoned pending sweep verified).
  - Full backend test suite (`npx vitest run`): **5 test files, 35 tests passed cleanly (0 failed)**.

### 2026-11-01 11:05 — Phase 2: Frontend Implementation (Prompts F1–F5)
- **Action**: Built full React 19 + Vite + TypeScript + Tailwind CSS application in `/frontend`.
- **Delivered**:
  - Typed API client in `src/api.ts` mapping error codes to `ApiError` and supporting XMLHttpRequest streaming upload with progress events and abort cancellation.
  - Drag-and-drop uploader page (`UploadPage.tsx`) with expiry presets, download quota input (1–100), optional password gate with reveal toggle, and error states.
  - Share result screen (`UploadPage.tsx`) with instant copy-to-clipboard, local expiry formatting, downloads summary, QR code generation (`qrcode.react`), and direct navigation.
  - Recipient portal (`DownloadPage.tsx` at `/d/:token`) implementing complete state machine: Loading, File Ready, Password Gate (with 5-try rate limit feedback and lockout), 404 Not Found, 410 Expired (with live second-by-second countdown ticker auto-transitioning to expired without page reload), and 410 Exhausted.
  - `ErrorBoundary.tsx` and `NotFoundPage.tsx` for production robustness.
  - Deployment guide in [`docs/FRONTEND_DEPLOY.md`](file:///c:/Users/manga/OneDrive/Desktop/New%20folder%20(4)/docs/FRONTEND_DEPLOY.md) covering S3 static hosting, CloudFront CDN, and SPA deep-link routing (403/404 -> `/index.html` with 200).
- **Verification Result**:
  - `npm run build` compiled client bundle with 0 errors (`dist/index.html` 0.49 kB, `dist/assets/index.js` 312 kB).

### 2026-11-01 11:22 — Phase 3: End-to-End System Integration (Playwright)
- **Action**: Scripted and ran the full 5-test end-to-end integration suite in `frontend/e2e/e2e.spec.ts` against the live stack (MinIO Docker container, Express API on port 3000, Vite frontend on port 5173).
- **Hard Requirements Tested**:
  1. Uploaded a real 20 MB binary payload to MinIO via pre-signed PUT, shared link, downloaded via pre-signed GET directly from MinIO, and verified byte-for-byte SHA-256 integrity match.
  2. Verified `max_downloads=1` link: initial download succeeded, second attempt immediately rendered self-destructed / exhausted state (410 `DOWNLOADS_EXHAUSTED`).
  3. Verified 1-minute expiry link: after expiration timestamp passed, portal live-switched to expired screen (410 `LINK_EXPIRED`) and S3 object was permanently purged.
  4. Verified password gate: wrong password displayed error message; correct password unlocked and downloaded file.
  5. Verified garbage / unknown token rendered 404 Share Link Not Found page.
- **Verification Output (`npx playwright test`)**:
  ```
  Running 5 tests using 1 worker

    ok 1 [chromium] › e2e/e2e.spec.ts › 1. Upload a 20 MB file, get a link, download it, confirm the bytes match (3.8s)
    ok 2 [chromium] › e2e/e2e.spec.ts › 2. Link with max_downloads=1: second download attempt shows exhausted (2.5s)
    ok 3 [chromium] › e2e/e2e.spec.ts › 3. Link with 1-minute expiry: after expiry portal shows expired and object is purged (1.7s)
    ok 4 [chromium] › e2e/e2e.spec.ts › 4. Password link: wrong password shows an error, correct one downloads (4.1s)
    ok 5 [chromium] › e2e/e2e.spec.ts › 5. Garbage token shows the not-found page (1.2s)

    5 passed (23.9s)
  ```

### 2026-11-01 16:32 — Phase 4: Production Vercel Launch & Cloud Deployment
- **Action**: Configured and deployed the frontend application to Vercel production.
- **Decisions & Fixes (ADR-010)**:
  1. **Vercel Project Setup**: Linked project `dropdead-share` under team `trps-urgewave` (`prj_vOQ0vD6pWIpiL7UOgq20MCe5LC5c`).
  2. **SPA Rewrites**: Added `frontend/vercel.json` rewriting `/(.*)` to `/index.html` to guarantee client-side React Router deep links (`/d/:token`) resolve with HTTP 200.
  3. **Node.js Runtime Alignment**: Set project setting `--node-version 24.x` to prevent Vercel unsupported Node 26 build failure.
  4. **Cross-Platform Dependency Cleanliness**: Removed Windows-specific `@rolldown/binding-win32-x64-msvc` from `package.json` and set `installCommand: npm install --legacy-peer-deps`.
  5. **Dynamic Backend Configuration**: Added reactive endpoint switcher in `Navbar.tsx` and `src/api.ts` with `localStorage` persistence, allowing users to connect the deployed Vercel frontend to any custom/tunneled backend without redeploying.
  6. **Public Accessibility**: Disabled team SSO deployment protection (`vercel project protection disable dropdead-share --sso`) for immediate public access.
  7. **Canonical Alias**: Aliased production deployment to [`https://dropdead-share.vercel.app`](https://dropdead-share.vercel.app).
- **Verification Output**:
  - `curl -i -s https://dropdead-share.vercel.app`:
    ```
    HTTP/1.1 200 OK
    Content-Type: text/html; charset=utf-8
    Server: Vercel
    <title>DropDead - Self-Destructing File Sharing</title>
    ```
  - Deep-link test (`curl -i -s https://dropdead-share.vercel.app/d/test-token-deep-link`):
    ```
    HTTP/1.1 200 OK
    Content-Disposition: inline; filename="index.html"
    ```

### 2026-11-02 08:35 — Phase 5: Utilitarian Frontend Redesign (ADR-011)
- **Action**: Completely redesigned the UI from generic landing-page aesthetic to a calm, utilitarian internal-tool interface.
- **Design System Implementation**:
  1. **Token Architecture**: Single source of truth in `src/index.css` and `tailwind.config.js`. Off-white `#fbfbfa` canvas, `#ffffff` panels, `#e4e4e7` hairline borders, `#18181b` text, and `#b91c1c` accent. Dark theme supported via `prefers-color-scheme`.
  2. **Typography**: Anchored on `IBM Plex Sans`. Monospace (`IBM Plex Mono`) restricted strictly to share URLs and tabular countdown numerals.
  3. **Visual Constraints**: Stripped all gradients, glows, blurs, shadows heavier than 1px borders, emojis, and pill badges. Radii capped at 6px max.
  4. **Upload Screen**: Single left-aligned column (max 560px), compact text-only drop area (no icon), sentence-style rule builder ("Delete after [duration] or [n] download(s). Password: [optional]"), single primary action button.
  5. **Result Screen**: Receipt-style key-value breakdown (File name, size, local expiry, downloads allowed, password flag), monospace link field with Copy feedback, small secondary QR code (84px).
  6. **Recipient Portal**: One clear state at a time. Countdown is dominant visual element with tabular digits. Error states (expired, exhausted, not found, wrong password) are plain specific sentences without illustrations.
  7. **Copywriting**: Stripped marketing jargon. All copy reflects precise facts ("The file is deleted from storage after expiry or download limit").
- **Verification Results**:
  - Full Playwright E2E Suite (`npx playwright test e2e/e2e.spec.ts`): **5 of 5 passed cleanly**.
  - Playwright Visual Screenshot Suite (`npx playwright test e2e/screenshots.spec.ts`): **Captured 18 screenshots across 1440px desktop and 375px mobile viewports**.
  - Visual inspection verified: left alignment, responsive reflow, tabular numeral alignment, and accessible focus rings.

### 2026-11-02 09:20 — Phase 6: Design Review Refinements & Accessibility Hardening (ADR-012)
- **Action**: Addressed comprehensive design feedback from screenshot review across typography, color hierarchy, contrast compliance, layout framing, copy precision, and state handling.
- **Key Design Refinements Implemented**:
  1. **Header & Footer Cleanup**:
     - Removed API URL pill badge from the header navigation (`Navbar.tsx` now only contains the brand link "DropDead").
     - Render API URL only during local development (`import.meta.env.DEV`) as a muted monospace footnote at the bottom of the page.
     - Removed redundant duplicate footer sentence from `App.tsx`.
  2. **Layout & Vertical Rhythm**:
     - Unified `Navbar`, main content, and footer inside one shared container: `max-w-[560px] mx-auto px-5 py-6 text-left`.
     - Vertically offset page content ~64px below header (`pt-16`).
  3. **Typography & WCAG AA Contrast Compliance**:
     - Base font size set to 16px (`1rem`) with line-height 1.5 (`24px`).
     - Page titles set to 26px (`text-2xl sm:text-[26px] font-semibold text-main`).
     - Darkened `--text-muted` to `#52525b` (zinc-600) on `#fbfbfa` canvas, achieving **7.2:1 contrast ratio**, exceeding WCAG AA 4.5:1 requirement. In dark mode, `#a1a1aa` on `#121212` yields **7.4:1 contrast ratio**.
     - Automated `@axe-core/playwright` accessibility audit passes with **0 violations** (`color-contrast`, `aria-valid-attr`, `button-name`, `label`).
  4. **Dropzone Interaction**:
     - Strengthened dashed border using `--border-default` (`#d4d4d8` light / `#2e2e32` dark).
     - Added visible hover state (`hover:border-border-strong`), drag-over state (`border-main bg-muted`), and keyboard focus ring (`tabIndex={0}`, Enter / Space triggers file picker, `focus:ring-2 focus:ring-main focus:ring-offset-2`).
  5. **Color Hierarchy Restraint**:
     - Primary buttons use near-black text color background (`bg-main` `#18181b` / dark: `#f4f4f5`) with white/canvas text (`text-canvas`).
     - Copy button converted to neutral secondary outline button (`bg-surface hover:bg-muted text-main border-border-default`).
     - Red accent (`#b91c1c` / `#ef4444`) restricted strictly to:
       - Error text and error validation messages.
       - Countdown ticker when less than 5 minutes remain.
  6. **Precise Sentence Case Copy**:
     - "Download File Directly" -> "Download".
     - Expired: title "This link has expired", body "The file is no longer available."
     - Exhausted: title "Download limit reached", body "This file is no longer available."
     - Not found: title "Link not found", body "Check the address, or ask the sender for a new link."
     - Result receipt title: "Link created".
     - Primary action button: "Create link".
     - Removed all assertions claiming storage objects are deleted at a specific instant.
  7. **Wrong Password & Lockout Telemetry**:
     - Updated `backend/src/middleware/error-handler.ts` to surface rate-limit headers (`ratelimit-remaining`, `ratelimit-reset`, `retry-after`) in error payloads as `attemptsLeft` and `retryAfterSeconds`.
     - On wrong password: displays "Incorrect password. N attempts left."
     - On 429 lockout: displays formatted retry countdown ("Too many attempts. Try again in 15 minutes.").
  8. **Accessible Countdown Ticker**:
     - Extended countdown formatter to support multi-day durations (`2d 23:59:59`).
     - Retained tabular numerals (`font-mono tabular-nums`).
     - Made screen reader announcements coarse by isolating visual second ticker (`aria-hidden="true"`) from an invisible `sr-only aria-live="polite"` element that updates only upon whole-minute transitions.
  9. **Share Link Ergonomics**:
     - Applied `break-all` to ensure share URL wraps cleanly on 375px mobile screens.
     - Added `onClick={(e) => e.currentTarget.select()}` to automatically select the full link on tap/click.
  10. **Comprehensive 15-State Visual Verification**:
     - Scripted in `frontend/e2e/screenshots.spec.ts` to capture and inspect all 15 scenarios across both 1440px desktop and 375px mobile viewports (30 total screenshots):
       1. Upload empty (`01-upload-empty-*.png`)
       2. Upload selected (`02-upload-selected-*.png`)
       3. Uploading with progress bar and cancel button held open (`03-uploading-progress-*.png`)
       4. Upload error feedback (`04-upload-error-*.png`)
       5. Result receipt without password (`05-result-without-password-*.png`)
       6. Result receipt with password (`06-result-with-password-*.png`)
       7. Portal ready (`07-portal-ready-*.png`)
       8. Password gate (`08-portal-password-gate-*.png`)
       9. Wrong password with attempts remaining (`09-portal-wrong-password-*.png`)
       10. Lockout rate limit countdown (`10-portal-lockout-*.png`)
       11. Expired state (`11-portal-expired-*.png`)
       12. Exhausted limit state (`12-portal-exhausted-*.png`)
       13. Not found state (`13-portal-not-found-*.png`)
       14. Dark mode upload screen (`14-dark-mode-upload-*.png`)
       15. Dark mode portal screen (`15-dark-mode-portal-*.png`)
- **Verification Outputs**:
  - `npx playwright test e2e/screenshots.spec.ts`: **2 of 2 tests passed cleanly (43.6s)**, axe-core 0 violations.
  - `npx playwright test e2e/e2e.spec.ts`: **5 of 5 end-to-end functional tests passed cleanly (21.1s)**.

### 2026-11-02 09:38 — Phase 7: GitHub & Vercel Publishing (ADR-013)
- **Action**: Published the complete monorepo to GitHub and deployed the redesigned frontend to Vercel production.
- **Deliverables**:
  1. **GitHub Repository**: Created public repository [`sohum123451/dropdead-share`](https://github.com/sohum123451/dropdead-share) on GitHub.
     - Pushed clean `main` branch with 95 files tracking `/backend`, `/frontend`, `/docs`, `docker-compose.yml`, test suites, and documentation.
     - Sensitive credentials (`.env`), SQLite databases (`metadata.db`), cache folders (`.tools`, `.vercel`, `node_modules`), and logs strictly ignored.
     - Added comprehensive root [`README.md`](file:///c:/Users/manga/OneDrive/Desktop/New%20folder%20(4)/README.md) with system architecture diagram, contract references, and quickstart commands.
  2. **Vercel Production Deployment**:
     - Resolved `tsc -b` unused variable lint check in `DownloadPage.tsx`.
     - Built and promoted production deployment `dpl_3mseVnWTDAdTSUizP758Guv492vo`.
     - Re-aliased canonical production domain to [`https://dropdead-share.vercel.app`](https://dropdead-share.vercel.app).
- **Verification Outputs**:
  - `curl.exe -I https://dropdead-share.vercel.app`: **HTTP/1.1 200 OK** (Content-Type: `text/html; charset=utf-8`, Server: `Vercel`).
  - `gh repo view sohum123451/dropdead-share`: **Repository active and tracking main**.

### 2026-11-02 09:55 — Phase 8: Cross-Device Access Root Cause & LAN Enablement (ADR-014)
- **Problem**: Scanning the QR code from another device (e.g. mobile phone) rendered `"Link not found"`.
- **Root Cause Analysis**:
  1. The backend API (`localhost:3000`), SQLite database, and MinIO storage (`localhost:9000`) were running solely on the host computer.
  2. `dropdead-share.vercel.app` only hosts the static React client; no backend is deployed on Vercel.
  3. When another device opened the link, it requested `/api/links/:token/info` from Vercel (or `localhost`), which returned fallback `index.html`.
  4. The frontend's `getLinkInfo` caught the non-JSON response and unconditionally defaulted to `setState('not_found')`, masking the underlying connection failure as an apparent missing link.
  5. Furthermore, generated pre-signed URLs pointed to `http://localhost:9000`, which remote devices cannot reach.
- **Resolutions Applied**:
  1. **LAN Network Binding**:
     - Configured `frontend/vite.config.ts` with `server.host: true` to broadcast on the local Wi-Fi (`http://192.168.29.165:5173`).
     - Set `backend/.env` with `S3_ENDPOINT=http://192.168.29.165:9000`, verified end-to-end upload and download from the LAN address.
     - Vite dev server automatically proxies `/api` calls from any LAN client to the local Express backend.
  2. **Error Taxonomy Precision**:
     - Updated `frontend/src/api.ts` to inspect `Content-Type`. If an endpoint returns HTML instead of JSON, an explicit `NETWORK_ERROR` is thrown instead of swallowing null.
     - Added `connection_error` portal state to `DownloadPage.tsx`: renders `"Cannot connect to server"` when the storage backend is unreachable, rather than misleading the user with `"Link not found"`.
  3. **Vercel & Git Synchronized**:
     - Built and promoted deployment `dpl_FPWkh2froJTDGN5yE24zZsHQ4fUv`.
     - Aliased to `https://dropdead-share.vercel.app`.
     - Committed and pushed commit `3f8b225` to GitHub `main`.

---
*End of Ledger. Subsequent changes, decisions, and test outputs will be appended below.*

