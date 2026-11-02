export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PASSWORD_REQUIRED'
  | 'WRONG_PASSWORD'
  | 'LINK_NOT_FOUND'
  | 'UPLOAD_NOT_FOUND'
  | 'LINK_EXPIRED'
  | 'DOWNLOADS_EXHAUSTED'
  | 'FILE_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export class ApiError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly attemptsLeft?: number;
  public readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    attemptsLeft?: number,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.attemptsLeft = attemptsLeft;
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface InitUploadInput {
  filename: string;
  fileSize: number;
  contentType: string;
  expiryValue: number;
  expiryUnit: 'minutes' | 'hours' | 'days';
  maxDownloads: number;
  password?: string;
}

export interface InitUploadResponse {
  uploadId: string;
  uploadUrl: string;
  uploadMethod: string;
  requiredHeaders: {
    'Content-Type': string;
    [key: string]: string;
  };
  expiresAt: string;
}

export interface FinalizeUploadResponse {
  token: string;
  sharePath: string;
  shareUrl: string;
  expiresAt: string;
  maxDownloads: number;
  isPasswordProtected: boolean;
}

export interface LinkInfoResponse {
  filename: string;
  fileSize: number;
  contentType: string;
  isPasswordProtected: boolean;
  expiresAt: string;
  remainingDownloads: number;
}

export interface VerifyPasswordResponse {
  verified: boolean;
  downloadGrantToken: string;
  expiresIn: number;
}

export interface DownloadResponse {
  downloadUrl: string;
  expiresIn: number;
  remainingDownloads: number;
}

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const custom = window.localStorage.getItem('dropdead_api_url');
    if (custom && custom.trim()) {
      return custom.trim().replace(/\/$/, '');
    }
  }
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL.replace(/\/$/, '');
  }
  if (import.meta.env.DEV) {
    return 'http://localhost:3000';
  }
  return '';
}

export function setCustomApiUrl(url: string | null): void {
  if (typeof window !== 'undefined') {
    if (!url || !url.trim()) {
      window.localStorage.removeItem('dropdead_api_url');
    } else {
      window.localStorage.setItem('dropdead_api_url', url.trim());
    }
  }
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new ApiError(
      'NETWORK_ERROR',
      `Server returned ${contentType || 'non-JSON'} instead of JSON (status ${res.status}). The API backend may be unreachable or not running on this domain.`,
      res.status
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(
      'NETWORK_ERROR',
      'Failed to parse JSON response from server.',
      res.status
    );
  }

  if (!res.ok) {
    const errorPayload = body as {
      error?: {
        code?: string;
        message?: string;
        attemptsLeft?: number;
        retryAfterSeconds?: number;
      };
    } | null;
    const code = (errorPayload?.error?.code as ErrorCode) || 'UNKNOWN_ERROR';
    const message = errorPayload?.error?.message || `Request failed with status ${res.status}`;

    // Read header fallbacks if not in body
    let attemptsLeft = errorPayload?.error?.attemptsLeft;
    if (attemptsLeft === undefined) {
      const headerVal = res.headers.get('ratelimit-remaining');
      if (headerVal !== null) {
        const parsed = parseInt(headerVal, 10);
        if (!isNaN(parsed)) attemptsLeft = parsed;
      }
    }

    let retryAfterSeconds = errorPayload?.error?.retryAfterSeconds;
    if (retryAfterSeconds === undefined) {
      const headerVal = res.headers.get('ratelimit-reset') || res.headers.get('retry-after');
      if (headerVal !== null) {
        const parsed = parseInt(headerVal, 10);
        if (!isNaN(parsed)) retryAfterSeconds = parsed;
      }
    }

    throw new ApiError(code, message, res.status, attemptsLeft, retryAfterSeconds);
  }

  return body as T;
}

/**
 * Step 1: Initialize upload session and obtain pre-signed PUT URL.
 */
export async function initUpload(payload: InitUploadInput): Promise<InitUploadResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/uploads/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<InitUploadResponse>(res);
}

/**
 * Step 2: Upload raw file payload directly to S3 via pre-signed PUT URL using XMLHttpRequest.
 * Provides real progress events and supports cancellation via abort().
 */
export function uploadDirectToS3(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress?: (progressPercent: number, loadedBytes: number, totalBytes: number) => void,
  cancelRef?: { abort?: () => void }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    if (cancelRef) {
      cancelRef.abort = () => {
        xhr.abort();
      };
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        onProgress(percent, event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new ApiError(
            'NETWORK_ERROR',
            `S3 direct upload failed with status ${xhr.status}`,
            xhr.status
          )
        );
      }
    };

    xhr.onerror = () => {
      reject(new ApiError('NETWORK_ERROR', 'Network connection error during S3 upload', 0));
    };

    xhr.onabort = () => {
      reject(new ApiError('NETWORK_ERROR', 'Upload cancelled by user', 0));
    };

    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.send(file);
  });
}

/**
 * Step 3: Finalize upload session after S3 upload succeeds.
 */
export async function finalizeUpload(uploadId: string): Promise<FinalizeUploadResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/uploads/${uploadId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return parseJsonResponse<FinalizeUploadResponse>(res);
}

/**
 * Recipient Portal: Retrieve link metadata without exposing file or storage URLs.
 */
export async function getLinkInfo(token: string): Promise<LinkInfoResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/links/${token}/info`);
  return parseJsonResponse<LinkInfoResponse>(res);
}

/**
 * Recipient Portal: Verify password and receive download grant token.
 */
export async function verifyPassword(
  token: string,
  password: string
): Promise<VerifyPasswordResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/links/${token}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return parseJsonResponse<VerifyPasswordResponse>(res);
}

/**
 * Recipient Portal: Request pre-signed GET download URL (atomically decrements remaining downloads).
 */
export async function requestDownload(
  token: string,
  options?: { password?: string; downloadGrantToken?: string }
): Promise<DownloadResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/links/${token}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options ?? {}),
  });
  return parseJsonResponse<DownloadResponse>(res);
}

