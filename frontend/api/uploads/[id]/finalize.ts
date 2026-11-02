import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getPendingRecord, saveActiveRecord } from '../../_lib/db.js';
import { findUploadedBlob } from '../../_lib/storage.js';

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

  const { id } = req.query;
  const uploadId = Array.isArray(id) ? id[0] : id;

  if (!uploadId) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Upload session ID required' },
    });
  }

  try {
    const pending = await getPendingRecord(uploadId);
    if (!pending) {
      return res.status(404).json({
        error: { code: 'UPLOAD_NOT_FOUND', message: 'Upload session not found or expired.' },
      });
    }

    // Verify blob in Vercel Blob store
    const check = await findUploadedBlob(uploadId);
    if (!check.exists || !check.url) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Uploaded file payload not found in storage.' },
      });
    }

    // Generate 32-char base64url share token
    const token = crypto.randomBytes(24).toString('base64url');

    pending.token = token;
    pending.status = 'active';
    pending.blobUrl = check.downloadUrl || check.url;

    await saveActiveRecord(pending);

    const host = req.headers.host || 'dropdead-share.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${proto}://${host}`;

    return res.status(201).json({
      token,
      sharePath: `/d/${token}`,
      shareUrl: `${baseUrl}/d/${token}`,
      expiresAt: pending.expiresAt,
      maxDownloads: pending.maxDownloads,
      isPasswordProtected: Boolean(pending.passwordHash),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Finalization failed.';
    return res.status(500).json({
      error: { code: 'UNKNOWN_ERROR', message: msg },
    });
  }
}

