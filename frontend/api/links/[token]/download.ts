import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRecordByToken, atomicDecrement } from '../../_lib/db.js';
import { verifyPasswordHash, verifyDownloadGrantToken } from '../../_lib/auth.js';
import { deleteBlob } from '../../_lib/storage.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
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

    // Download quota check
    if (record.remainingDownloads <= 0 || record.status === 'dead') {
      await deleteBlob(record.blobUrl);
      return res.status(410).json({
        error: { code: 'DOWNLOADS_EXHAUSTED', message: 'Download quota for this link is exhausted.' },
      });
    }

    // Password authorization check
    if (record.passwordHash) {
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const bodyGrantToken = req.body?.downloadGrantToken;
      const bodyPassword = req.body?.password;

      let authorized = false;

      if (bearerToken && verifyDownloadGrantToken(bearerToken, linkToken)) {
        authorized = true;
      } else if (bodyGrantToken && verifyDownloadGrantToken(bodyGrantToken, linkToken)) {
        authorized = true;
      } else if (bodyPassword && (await verifyPasswordHash(bodyPassword, record.passwordHash))) {
        authorized = true;
      }

      if (!authorized) {
        return res.status(401).json({
          error: {
            code: 'PASSWORD_REQUIRED',
            message: 'Password or valid download grant token required.',
          },
        });
      }
    }

    // Atomic decrement
    const result = await atomicDecrement(linkToken);

    if (!result.success) {
      if (result.reason === 'EXPIRED') {
        await deleteBlob(record.blobUrl);
        return res.status(410).json({
          error: { code: 'LINK_EXPIRED', message: 'This link has expired.' },
        });
      }
      if (result.reason === 'EXHAUSTED') {
        await deleteBlob(record.blobUrl);
        return res.status(410).json({
          error: { code: 'DOWNLOADS_EXHAUSTED', message: 'Download quota for this link is exhausted.' },
        });
      }
      return res.status(404).json({
        error: { code: 'LINK_NOT_FOUND', message: 'Share link not found.' },
      });
    }

    const updated = result.record!;

    // If quota hit 0, purge blob immediately
    if (updated.remainingDownloads === 0) {
      await deleteBlob(updated.blobUrl);
    }

    return res.status(200).json({
      downloadUrl: updated.blobUrl,
      expiresIn: 60,
      remainingDownloads: updated.remainingDownloads,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Download request failed.';
    return res.status(500).json({
      error: { code: 'UNKNOWN_ERROR', message: msg },
    });
  }
}

