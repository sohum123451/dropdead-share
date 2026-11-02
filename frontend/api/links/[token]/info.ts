import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRecordByToken } from '../../_lib/db.js';
import { deleteBlob } from '../../_lib/storage.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'VALIDATION_ERROR', message: 'Method not allowed' },
    });
  }

  const { token } = req.query;
  const linkToken = Array.isArray(token) ? token[0] : token;

  if (!linkToken) {
    return res.status(404).json({
      error: { code: 'LINK_NOT_FOUND', message: 'Share link not found.' },
    });
  }

  try {
    const record = await getRecordByToken(linkToken);

    if (!record || record.status === 'pending') {
      return res.status(404).json({
        error: { code: 'LINK_NOT_FOUND', message: 'Share link not found.' },
      });
    }

    // Lazy expiry check
    if (new Date() >= new Date(record.expiresAt)) {
      await deleteBlob(record.blobUrl);
      return res.status(410).json({
        error: { code: 'LINK_EXPIRED', message: 'This link has expired.' },
      });
    }

    // Quota exhaustion check
    if (record.remainingDownloads <= 0 || record.status === 'dead') {
      await deleteBlob(record.blobUrl);
      return res.status(410).json({
        error: { code: 'DOWNLOADS_EXHAUSTED', message: 'Download quota for this link is exhausted.' },
      });
    }

    return res.status(200).json({
      filename: record.originalName,
      fileSize: record.sizeBytes,
      contentType: record.mime,
      isPasswordProtected: Boolean(record.passwordHash),
      expiresAt: record.expiresAt,
      remainingDownloads: record.remainingDownloads,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to retrieve link info.';
    return res.status(500).json({
      error: { code: 'UNKNOWN_ERROR', message: msg },
    });
  }
}

