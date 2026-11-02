# Self-Destructing File Sharing API Specification

## 1. Overview & Architecture

This document defines the HTTP API specification for the self-destructing file sharing service.

### 1.1 Core Principles & Rules
- **Direct-to-Storage Transfer**: File payload bytes never transit the application server. Uploads stream directly to S3 via pre-signed `PUT` URLs; downloads stream directly from S3 via pre-signed `GET` URLs.
- **Link Token Format**: Links are identified by `/d/:token`. Tokens are cryptographically secure random strings generated via `crypto.randomBytes` (minimum 32 bytes / 64 hex characters or 43 base64url characters), strictly non-sequential and unguessable.
- **Self-Destruction Lifecycle**: A link is permanently dead when either of the following conditions is met:
  1. `remainingDownloads <= 0` (atomically decremented upon generation of download URL).
  2. `now > expiresAt` (uploader-defined timestamp).
- **Dead Link Purge**: Once expired or exhausted, the backing S3 object is flagged for deletion / purged, and subsequent requests return HTTP `410 Gone`.

---

## 2. Common Data Types & Standards

### 2.1 Standard Headers
- Request `Content-Type`: `application/json` (for all POST requests)
- Response `Content-Type`: `application/json`

### 2.2 Standard Error Response Shape
All non-`2xx` error responses adhere to the uniform error wrapper:

```json
{
  "error": {
    "code": "STRING",
    "message": "Human-readable description of the error."
  }
}
```

### 2.3 Error Code Reference Table

| HTTP Status | Error Code | Description |
|:---|:---|:---|
| `400 Bad Request` | `VALIDATION_ERROR` | Request payload fails schema validation, invalid types, or missing required fields. |
| `401 Unauthorized` | `PASSWORD_REQUIRED` | The resource is password-protected, but no password or authorization token was provided. |
| `401 Unauthorized` | `WRONG_PASSWORD` | The provided password does not match. |
| `404 Not Found` | `LINK_NOT_FOUND` | No link exists for the provided token. |
| `404 Not Found` | `UPLOAD_NOT_FOUND` | The upload session ID was not found or has already been finalized. |
| `410 Gone` | `LINK_EXPIRED` | The link's lifetime (`expiresAt`) has passed. |
| `410 Gone` | `DOWNLOADS_EXHAUSTED` | The link has reached its maximum allowed downloads (`remainingDownloads === 0`). |
| `413 Payload Too Large` | `FILE_TOO_LARGE` | Declared file size exceeds maximum server limit (e.g., > 1 GB). |
| `429 Too Many Requests` | `RATE_LIMITED` | Rate limit threshold exceeded for client IP or token. |

---

## 3. Endpoints

---

### 3.1 Initialize Upload Session

Prepares an upload session, generates a single-use S3 pre-signed `PUT` URL, and stores pending upload configuration.

- **Method**: `POST`
- **Path**: `/api/uploads/init`

#### Request Body
| Field | Type | Required | Constraints | Description |
|:---|:---|:---|:---|:---|
| `filename` | `string` | Yes | 1–255 chars | Original filename of the upload. |
| `fileSize` | `integer` | Yes | > 0, <= 1073741824 | File size in bytes (max 1 GB). |
| `contentType` | `string` | Yes | Valid MIME type | MIME type of the file. |
| `expiryValue` | `integer` | Yes | >= 1 | Numerical duration until link expiration. |
| `expiryUnit` | `string` | Yes | `"minutes" \| "hours" \| "days"` | Time unit for expiration. |
| `maxDownloads` | `integer` | Yes | 1 – 100 | Total allowed successful download attempts. |
| `password` | `string` | No | 4–128 chars | Optional password required to unlock download. |

#### Request Example
```json
{
  "filename": "confidential_financials.pdf",
  "fileSize": 2457600,
  "contentType": "application/pdf",
  "expiryValue": 24,
  "expiryUnit": "hours",
  "maxDownloads": 5,
  "password": "CorrectHorseBatteryStaple!9"
}
```

#### Response: `201 Created`
```json
{
  "uploadId": "upl_9f8c1b3a2e4d5c6b7a8091",
  "uploadUrl": "https://storage.example.com/uploads/upl_9f8c1b3a2e4d5c6b7a8091?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&...",
  "uploadMethod": "PUT",
  "requiredHeaders": {
    "Content-Type": "application/pdf"
  },
  "expiresAt": "2026-11-01T12:00:00.000Z"
}
```

#### Error Responses
- `400 Bad Request` (`VALIDATION_ERROR`): Invalid `maxDownloads` out of range 1-100, invalid unit, or malformed fields.
- `413 Payload Too Large` (`FILE_TOO_LARGE`): `fileSize` exceeds maximum threshold.
- `429 Too Many Requests` (`RATE_LIMITED`): Client exceeded initialization rate limits.

---

### 3.2 Finalize Upload Session

Confirms that the object was uploaded to storage, validates object presence/integrity in S3, creates the shareable token, and returns the final share link.

- **Method**: `POST`
- **Path**: `/api/uploads/:id/finalize`

#### Path Parameters
| Parameter | Type | Description |
|:---|:---|:---|
| `id` | `string` | The upload session identifier returned by `/api/uploads/init`. |

#### Request Body
Empty JSON object `{}`.

#### Request Example
```json
{}
```

#### Response: `201 Created`
```json
{
  "token": "e6a48f4b0051e948f93e3d48995a2e5c8e291bc413f17d83ad6f73db59b6f881",
  "sharePath": "/d/e6a48f4b0051e948f93e3d48995a2e5c8e291bc413f17d83ad6f73db59b6f881",
  "shareUrl": "https://files.example.com/d/e6a48f4b0051e948f93e3d48995a2e5c8e291bc413f17d83ad6f73db59b6f881",
  "expiresAt": "2026-11-01T12:00:00.000Z",
  "maxDownloads": 5,
  "isPasswordProtected": true
}
```

#### Error Responses
- `404 Not Found` (`UPLOAD_NOT_FOUND`): Upload session ID does not exist or has expired without upload.
- `400 Bad Request` (`VALIDATION_ERROR`): S3 object does not exist or object size mismatch.
- `429 Too Many Requests` (`RATE_LIMITED`): Rate limit exceeded.

---

### 3.3 Get Link Metadata Info

Retrieves non-sensitive metadata about a shared link. Used by recipient landing page `/d/:token` before initiating download or requesting password entry. Does **not** decrement download counter and does **not** expose storage URLs.

- **Method**: `GET`
- **Path**: `/api/links/:token/info`

#### Path Parameters
| Parameter | Type | Description |
|:---|:---|:---|
| `token` | `string` | 32+ character crypto random hex/base64 token. |

#### Request Example
```http
GET /api/links/e6a48f4b0051e948f93e3d48995a2e5c8e291bc413f17d83ad6f73db59b6f881/info HTTP/1.1
Host: files.example.com
```

#### Response: `200 OK`
```json
{
  "filename": "confidential_financials.pdf",
  "fileSize": 2457600,
  "contentType": "application/pdf",
  "isPasswordProtected": true,
  "expiresAt": "2026-11-01T12:00:00.000Z",
  "remainingDownloads": 5
}
```

#### Error Responses
- `404 Not Found` (`LINK_NOT_FOUND`): Token does not exist.
  ```json
  {
    "error": {
      "code": "LINK_NOT_FOUND",
      "message": "The requested share link does not exist."
    }
  }
  ```
- `410 Gone` (`LINK_EXPIRED`): The expiration timestamp has passed.
  ```json
  {
    "error": {
      "code": "LINK_EXPIRED",
      "message": "This file share link has expired and is no longer accessible."
    }
  }
  ```
- `410 Gone` (`DOWNLOADS_EXHAUSTED`): Download quota reached (`remainingDownloads === 0`).
  ```json
  {
    "error": {
      "code": "DOWNLOADS_EXHAUSTED",
      "message": "This file share link has reached its maximum download limit and has been destroyed."
    }
  }
  ```
- `429 Too Many Requests` (`RATE_LIMITED`): Excessive info requests.

---

### 3.4 Verify Link Password

Verifies the password for a password-protected link and issues a short-lived download grant token.

- **Method**: `POST`
- **Path**: `/api/links/:token/verify`

#### Path Parameters
| Parameter | Type | Description |
|:---|:---|:---|
| `token` | `string` | 32+ character link token. |

#### Request Body
| Field | Type | Required | Description |
|:---|:---|:---|:---|
| `password` | `string` | Yes | The password supplied by the recipient. |

#### Request Example
```json
{
  "password": "CorrectHorseBatteryStaple!9"
}
```

#### Response: `200 OK`
```json
{
  "verified": true,
  "downloadGrantToken": "dgt_3b8a1c90e4f271a68d0e5f4c2b1a9987",
  "expiresIn": 120
}
```

#### Error Responses
- `401 Unauthorized` (`WRONG_PASSWORD`): Invalid password provided.
  ```json
  {
    "error": {
      "code": "WRONG_PASSWORD",
      "message": "The provided password is incorrect."
    }
  }
  ```
- `400 Bad Request` (`VALIDATION_ERROR`): Password field missing or empty.
- `404 Not Found` (`LINK_NOT_FOUND`): Token does not exist.
- `410 Gone` (`LINK_EXPIRED`): Link has expired.
- `410 Gone` (`DOWNLOADS_EXHAUSTED`): Download quota already depleted.
- `429 Too Many Requests` (`RATE_LIMITED`): Too many incorrect attempts (brute-force defense).

---

### 3.5 Request Download URL

Atomically decrements the remaining download count and returns a short-lived (60 seconds) pre-signed S3 `GET` URL for immediate file download.

- **Method**: `POST`
- **Path**: `/api/links/:token/download`

#### Path Parameters
| Parameter | Type | Description |
|:---|:---|:---|
| `token` | `string` | 32+ character link token. |

#### Request Body
| Field | Type | Required | Description |
|:---|:---|:---|:---|
| `password` | `string` | Optional* | Plaintext password (if `downloadGrantToken` not provided). |
| `downloadGrantToken` | `string` | Optional* | Token obtained from `/api/links/:token/verify`. |

*\*Note: For password-protected links, either `password` or `downloadGrantToken` must be supplied. For non-protected links, the body can be `{}`.*

#### Request Example
```json
{
  "downloadGrantToken": "dgt_3b8a1c90e4f271a68d0e5f4c2b1a9987"
}
```

#### Response: `200 OK`
```json
{
  "downloadUrl": "https://storage.example.com/uploads/upl_9f8c1b3a2e4d5c6b7a8091?response-content-disposition=attachment%3B%20filename%3D%22confidential_financials.pdf%22&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=60&...",
  "expiresIn": 60,
  "remainingDownloads": 4
}
```

#### Atomicity & Concurrency Behavior
- The remaining download count is decremented in a single atomic database operation (`remainingDownloads = remainingDownloads - 1 WHERE remainingDownloads > 0 AND expiresAt > NOW()`).
- If remaining downloads drop to `0` as a result of this operation, background cleanup is immediately dispatched to delete the S3 object.
- If concurrent requests attempt to decrement the count when `remainingDownloads === 1`, only one request will succeed with `200 OK`. The other will fail with `410 Gone` (`DOWNLOADS_EXHAUSTED`).

#### Error Responses
- `401 Unauthorized` (`PASSWORD_REQUIRED`): Link is password-protected, but neither `password` nor `downloadGrantToken` was provided.
  ```json
  {
    "error": {
      "code": "PASSWORD_REQUIRED",
      "message": "This file is password-protected. Please provide a valid password or download grant token."
    }
  }
  ```
- `401 Unauthorized` (`WRONG_PASSWORD`): Invalid password or expired `downloadGrantToken`.
- `404 Not Found` (`LINK_NOT_FOUND`): Token does not exist.
- `410 Gone` (`LINK_EXPIRED`): Link has expired past its validity window.
- `410 Gone` (`DOWNLOADS_EXHAUSTED`): Download quota is zero.
- `429 Too Many Requests` (`RATE_LIMITED`): Rate limit exceeded.

---

### 3.6 Health Check

Service health status indicator for load balancers and deployment verification.

- **Method**: `GET`
- **Path**: `/health`

#### Request Example
```http
GET /health HTTP/1.1
Host: files.example.com
```

#### Response: `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2026-10-31T12:00:00.000Z"
}
```
