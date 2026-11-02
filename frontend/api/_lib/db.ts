import { put, del, head, list } from '@vercel/blob';
import pg from 'pg';

export interface FileRecord {
  id: string;
  token: string;
  blobUrl: string;
  originalName: string;
  sizeBytes: number;
  mime: string;
  passwordHash: string | null;
  expiresAt: string;
  maxDownloads: number;
  remainingDownloads: number;
  status: 'pending' | 'active' | 'dead';
  createdAt: string;
}

const BLOB_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN ||
  'vercel_blob_rw_2oHDFhQdmhqjsVw4_lbrq8NX8HKGbznnTYoNbUtjG7QkWbg';

// Optional PostgreSQL Pool if DATABASE_URL is provided
let pool: pg.Pool | null = null;
let pgInitialized = false;

if (process.env.DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function ensurePgSchema() {
  if (!pool || pgInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id VARCHAR(64) PRIMARY KEY,
      token VARCHAR(64) UNIQUE,
      blob_url TEXT NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      size_bytes BIGINT NOT NULL,
      mime VARCHAR(128) NOT NULL,
      password_hash TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      max_downloads INT NOT NULL,
      remaining_downloads INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_files_token ON files(token);
  `);
  pgInitialized = true;
}

export async function savePendingRecord(record: FileRecord): Promise<void> {
  if (pool) {
    await ensurePgSchema();
    await pool.query(
      `INSERT INTO files (id, token, blob_url, original_name, size_bytes, mime, password_hash, expires_at, max_downloads, remaining_downloads, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET blob_url = $3, status = $11`,
      [
        record.id,
        record.token,
        record.blobUrl,
        record.originalName,
        record.sizeBytes,
        record.mime,
        record.passwordHash,
        record.expiresAt,
        record.maxDownloads,
        record.remainingDownloads,
        record.status,
        record.createdAt,
      ]
    );
  } else {
    // Persist to Vercel Blob store
    await put(`meta/pending/${record.id}.json`, JSON.stringify(record), {
      access: 'public',
      token: BLOB_TOKEN,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }
}

export async function getPendingRecord(id: string): Promise<FileRecord | null> {
  if (pool) {
    await ensurePgSchema();
    const res = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      token: row.token,
      blobUrl: row.blob_url,
      originalName: row.original_name,
      sizeBytes: Number(row.size_bytes),
      mime: row.mime,
      passwordHash: row.password_hash,
      expiresAt: new Date(row.expires_at).toISOString(),
      maxDownloads: row.max_downloads,
      remainingDownloads: row.remaining_downloads,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  try {
    const meta = await head(`meta/pending/${id}.json`, { token: BLOB_TOKEN });
    const res = await fetch(`${meta.url}?_t=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache, no-store' },
    });
    if (!res.ok) return null;
    return (await res.json()) as FileRecord;
  } catch {
    return null;
  }
}

export async function saveActiveRecord(record: FileRecord): Promise<void> {
  if (pool) {
    await ensurePgSchema();
    await pool.query(
      `UPDATE files 
       SET token = $1, password_hash = $2, status = 'active'
       WHERE id = $3`,
      [record.token, record.passwordHash, record.id]
    );
  } else {
    // Write immutable active link definition
    await put(`meta/links/${record.token}/meta.json`, JSON.stringify(record), {
      access: 'public',
      token: BLOB_TOKEN,
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    // Remove pending meta
    try {
      const pBlob = await head(`meta/pending/${record.id}.json`, { token: BLOB_TOKEN });
      await del(pBlob.url, { token: BLOB_TOKEN });
    } catch {
      // Ignore if already deleted
    }
  }
}

export async function getRecordByToken(token: string): Promise<FileRecord | null> {
  if (pool) {
    await ensurePgSchema();
    const res = await pool.query('SELECT * FROM files WHERE token = $1', [token]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      token: row.token,
      blobUrl: row.blob_url,
      originalName: row.original_name,
      sizeBytes: Number(row.size_bytes),
      mime: row.mime,
      passwordHash: row.password_hash,
      expiresAt: new Date(row.expires_at).toISOString(),
      maxDownloads: row.max_downloads,
      remainingDownloads: row.remaining_downloads,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  try {
    // Primary path: meta/links/${token}/meta.json
    let metaUrl: string | null = null;
    try {
      const metaBlob = await head(`meta/links/${token}/meta.json`, { token: BLOB_TOKEN });
      metaUrl = metaBlob.url;
    } catch {
      // Fallback for legacy format
      try {
        const legacyBlob = await head(`meta/links/${token}.json`, { token: BLOB_TOKEN });
        metaUrl = legacyBlob.url;
      } catch {
        return null;
      }
    }

    if (!metaUrl) return null;

    const res = await fetch(`${metaUrl}?_t=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache, no-store' },
    });
    if (!res.ok) return null;
    const record = (await res.json()) as FileRecord;

    // Direct uncached query to count download events
    const downloadLogs = await list({
      prefix: `meta/links/${token}/downloads/`,
      token: BLOB_TOKEN,
    });

    const usedDownloads = downloadLogs.blobs.length;
    const remaining = Math.max(0, record.maxDownloads - usedDownloads);
    record.remainingDownloads = remaining;

    if (remaining <= 0) {
      record.status = 'dead';
    }

    return record;
  } catch {
    return null;
  }
}

export async function atomicDecrement(
  token: string
): Promise<{ success: boolean; record?: FileRecord; reason?: 'EXPIRED' | 'EXHAUSTED' | 'NOT_FOUND' }> {
  const nowIso = new Date().toISOString();

  if (pool) {
    await ensurePgSchema();
    const res = await pool.query(
      `UPDATE files 
       SET remaining_downloads = remaining_downloads - 1,
           status = CASE WHEN remaining_downloads - 1 = 0 THEN 'dead' ELSE status END
       WHERE token = $1 AND remaining_downloads > 0 AND expires_at > $2 AND status = 'active'
       RETURNING *`,
      [token, nowIso]
    );

    if (res.rows.length === 0) {
      const existing = await getRecordByToken(token);
      if (!existing) return { success: false, reason: 'NOT_FOUND' };
      if (new Date(existing.expiresAt) <= new Date()) return { success: false, reason: 'EXPIRED' };
      return { success: false, reason: 'EXHAUSTED' };
    }

    const row = res.rows[0];
    const updated: FileRecord = {
      id: row.id,
      token: row.token,
      blobUrl: row.blob_url,
      originalName: row.original_name,
      sizeBytes: Number(row.size_bytes),
      mime: row.mime,
      passwordHash: row.password_hash,
      expiresAt: new Date(row.expires_at).toISOString(),
      maxDownloads: row.max_downloads,
      remainingDownloads: row.remaining_downloads,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    };

    return { success: true, record: updated };
  }

  // Event-sourced transactional log implementation
  const current = await getRecordByToken(token);
  if (!current) return { success: false, reason: 'NOT_FOUND' };

  if (new Date(current.expiresAt) <= new Date()) {
    current.status = 'dead';
    return { success: false, reason: 'EXPIRED' };
  }

  if (current.remainingDownloads <= 0 || current.status === 'dead') {
    return { success: false, reason: 'EXHAUSTED' };
  }

  // Next download event number (e.g., 1, 2, ...)
  const downloadNum = current.maxDownloads - current.remainingDownloads + 1;

  // Write immutable download receipt
  await put(`meta/links/${token}/downloads/${downloadNum}.json`, JSON.stringify({
    downloadedAt: new Date().toISOString(),
    downloadIndex: downloadNum,
  }), {
    access: 'public',
    token: BLOB_TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  current.remainingDownloads -= 1;
  if (current.remainingDownloads === 0) {
    current.status = 'dead';
  }

  return { success: true, record: current };
}
