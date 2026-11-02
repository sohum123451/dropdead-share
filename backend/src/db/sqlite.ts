import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface FileRecord {
  id: string;
  token: string | null;
  s3_key: string;
  original_name: string;
  size_bytes: number;
  mime: string;
  password_hash: string | null;
  pending_password?: string | null;
  expires_at: string;
  max_downloads: number;
  remaining_downloads: number;
  status: 'pending' | 'active' | 'dead';
  created_at: string;
}

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = env.DATABASE_ABSOLUTE_PATH;
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    logger.info({ dbDir }, 'Created database directory');
  }

  dbInstance = new Database(dbPath);

  // WAL mode for improved concurrent read/write performance
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  initSchema(dbInstance);

  logger.info({ path: dbPath }, 'SQLite database connected and initialized');
  return dbInstance;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE,
      s3_key TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime TEXT NOT NULL,
      password_hash TEXT,
      pending_password TEXT,
      expires_at TEXT NOT NULL,
      max_downloads INTEGER NOT NULL,
      remaining_downloads INTEGER NOT NULL,
      status TEXT CHECK(status IN ('pending', 'active', 'dead')) NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_files_token ON files(token);
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
  `);

  // Ensure schema compatibility if table already existed with previous schema
  try {
    const tableInfo = db.pragma('table_info(files)') as Array<{ name: string; notnull: number }>;
    const hasPendingPassword = tableInfo.some((col) => col.name === 'pending_password');
    if (!hasPendingPassword) {
      db.exec(`ALTER TABLE files ADD COLUMN pending_password TEXT;`);
    }

    const tokenCol = tableInfo.find((col) => col.name === 'token');
    if (tokenCol && tokenCol.notnull === 1) {
      db.exec(`
        CREATE TABLE files_migration (
          id TEXT PRIMARY KEY,
          token TEXT UNIQUE,
          s3_key TEXT NOT NULL,
          original_name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          mime TEXT NOT NULL,
          password_hash TEXT,
          pending_password TEXT,
          expires_at TEXT NOT NULL,
          max_downloads INTEGER NOT NULL,
          remaining_downloads INTEGER NOT NULL,
          status TEXT CHECK(status IN ('pending', 'active', 'dead')) NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO files_migration SELECT id, token, s3_key, original_name, size_bytes, mime, password_hash, NULL, expires_at, max_downloads, remaining_downloads, status, created_at FROM files;
        DROP TABLE files;
        ALTER TABLE files_migration RENAME TO files;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_files_token ON files(token);
        CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
        CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
      `);
    }
  } catch (err) {
    logger.warn({ err }, 'Schema migration check completed with warning');
  }
}

export function createPendingFile(input: {
  id: string;
  s3Key: string;
  originalName: string;
  sizeBytes: number;
  mime: string;
  pendingPassword?: string | null;
  expiresAt: string;
  maxDownloads: number;
}): FileRecord {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO files (
      id, token, s3_key, original_name, size_bytes, mime,
      password_hash, pending_password, expires_at,
      max_downloads, remaining_downloads, status, created_at
    ) VALUES (
      @id, NULL, @s3Key, @originalName, @sizeBytes, @mime,
      NULL, @pendingPassword, @expiresAt,
      @maxDownloads, @maxDownloads, 'pending', @createdAt
    )
  `);

  const createdAt = new Date().toISOString();
  stmt.run({
    id: input.id,
    s3Key: input.s3Key,
    originalName: input.originalName,
    sizeBytes: input.sizeBytes,
    mime: input.mime,
    pendingPassword: input.pendingPassword ?? null,
    expiresAt: input.expiresAt,
    maxDownloads: input.maxDownloads,
    createdAt,
  });

  return getFileById(input.id)!;
}

export function getFileById(id: string): FileRecord | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | undefined;
  return row ?? null;
}

export function getFileByToken(token: string): FileRecord | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM files WHERE token = ?').get(token) as FileRecord | undefined;
  return row ?? null;
}

export function finalizePendingFile(
  id: string,
  token: string,
  passwordHash: string | null
): FileRecord | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE files
    SET status = 'active',
        token = ?,
        password_hash = ?,
        pending_password = NULL
    WHERE id = ? AND status = 'pending'
  `);
  const info = stmt.run(token, passwordHash, id);
  if (info.changes === 0) {
    return null;
  }
  return getFileById(id);
}

export function markFileAbandoned(id: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE files
    SET status = 'dead',
        pending_password = NULL
    WHERE id = ? AND status = 'pending'
  `);
  const info = stmt.run(id);
  return info.changes > 0;
}

export function markFileDead(id: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`UPDATE files SET status = 'dead', pending_password = NULL WHERE id = ?`);
  const info = stmt.run(id);
  return info.changes > 0;
}

export function atomicDecrementDownloads(token: string, nowIso: string): {
  success: boolean;
  file?: FileRecord;
  reason?: 'NOT_FOUND' | 'EXPIRED' | 'EXHAUSTED';
} {
  const db = getDatabase();
  const updateStmt = db.prepare(`
    UPDATE files
    SET remaining_downloads = remaining_downloads - 1,
        status = CASE WHEN remaining_downloads - 1 <= 0 THEN 'dead' ELSE status END
    WHERE token = ?
      AND remaining_downloads > 0
      AND expires_at > ?
      AND status = 'active'
  `);

  const result = updateStmt.run(token, nowIso);
  if (result.changes === 1) {
    const file = getFileByToken(token)!;
    return { success: true, file };
  }

  // Determine failure reason
  const existing = getFileByToken(token);
  if (!existing) {
    return { success: false, reason: 'NOT_FOUND' };
  }

  if (nowIso > existing.expires_at) {
    if (existing.status !== 'dead') {
      db.prepare(`UPDATE files SET status = 'dead' WHERE id = ?`).run(existing.id);
    }
    return { success: false, reason: 'EXPIRED' };
  }

  return { success: false, reason: 'EXHAUSTED' };
}

export function getFilesForCleanup(nowIso: string): FileRecord[] {
  const db = getDatabase();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM files
    WHERE status = 'dead'
       OR (status = 'active' AND (expires_at <= ? OR remaining_downloads <= 0))
       OR (status = 'pending' AND created_at < ?)
  `).all(nowIso, oneHourAgo) as FileRecord[];
  return rows;
}

export function deleteFileRecord(id: string): boolean {
  const db = getDatabase();
  const info = db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
  return info.changes > 0;
}

export function cleanupAbandonedPendingFiles(): number {
  const db = getDatabase();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stmt = db.prepare(`
    UPDATE files
    SET status = 'dead',
        pending_password = NULL
    WHERE status = 'pending' AND created_at < ?
  `);
  const info = stmt.run(oneHourAgo);
  return info.changes;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('SQLite database connection closed');
  }
}
