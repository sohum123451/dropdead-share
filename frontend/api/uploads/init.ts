import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { z } from 'zod';
import { savePendingRecord, type FileRecord } from '../_lib/db.js';
import { createUploadPresignedUrl } from '../_lib/storage.js';
import { hashPassword } from '../_lib/auth.js';

const initSchema = z.object({
  filename: z.string().min(1).max(255),
  fileSize: z.coerce.number().positive(),
  contentType: z.string().min(1).default('application/octet-stream'),
  expiryValue: z.coerce.number().positive(),
  expiryUnit: z.enum(['minutes', 'hours', 'days']),
  maxDownloads: z.coerce.number().int().min(1).max(100),
  password: z.string().optional(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: { code: 'VALIDATION_ERROR', message: 'Method not allowed' },
    });
  }

  const parseResult = initSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid upload configuration parameters.',
      },
    });
  }

  const {
    filename,
    fileSize,
    contentType,
    expiryValue,
    expiryUnit,
    maxDownloads,
    password,
  } = parseResult.data;

  // Max size: 1024 MB
  if (fileSize > 1024 * 1024 * 1024) {
    return res.status(413).json({
      error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds maximum allowed.' },
    });
  }

  // Calculate expires_at
  const now = Date.now();
  let ms = expiryValue * 60 * 1000;
  if (expiryUnit === 'hours') ms = expiryValue * 3600 * 1000;
  if (expiryUnit === 'days') ms = expiryValue * 24 * 3600 * 1000;
  const expiresAt = new Date(now + ms).toISOString();

  const uploadId = `upl_${crypto.randomUUID().replace(/-/g, '')}`;
  const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const blobPathname = `uploads/${uploadId}/${sanitizedName}`;

  try {
    const { uploadUrl } = await createUploadPresignedUrl(blobPathname);

    let passwordHash: string | null = null;
    if (password && password.trim()) {
      passwordHash = await hashPassword(password.trim());
    }

    const pendingRecord: FileRecord = {
      id: uploadId,
      token: '',
      blobUrl: blobPathname,
      originalName: filename,
      sizeBytes: fileSize,
      mime: contentType,
      passwordHash,
      expiresAt,
      maxDownloads,
      remainingDownloads: maxDownloads,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await savePendingRecord(pendingRecord);

    return res.status(201).json({
      uploadId,
      uploadUrl,
      uploadMethod: 'PUT',
      requiredHeaders: {
        'Content-Type': contentType,
      },
      expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Upload initialization failed.';
    return res.status(500).json({
      error: { code: 'UNKNOWN_ERROR', message: msg },
    });
  }
}

