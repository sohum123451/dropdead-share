import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Creates a short-lived (default 5-minute) HMAC-signed download grant token.
 * Format: dgt_<base64url(token:expiresAtMs:nonce)>.<signature>
 */
export function createDownloadGrantToken(token: string, expiresInSeconds: number = 300): string {
  const expiresAtMs = Date.now() + expiresInSeconds * 1000;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${token}:${expiresAtMs}:${nonce}`;
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', env.GRANT_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');

  return `dgt_${encodedPayload}.${signature}`;
}

/**
 * Verifies that the download grant token is cryptographically valid,
 * bound to the expected share token, and has not expired.
 */
export function verifyDownloadGrantToken(grantToken: string, expectedToken: string): boolean {
  if (!grantToken || typeof grantToken !== 'string' || !grantToken.startsWith('dgt_')) {
    return false;
  }

  const raw = grantToken.slice(4);
  const dotIndex = raw.lastIndexOf('.');
  if (dotIndex === -1) {
    return false;
  }

  const encodedPayload = raw.slice(0, dotIndex);
  const signature = raw.slice(dotIndex + 1);

  let payload = '';
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', env.GRANT_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  const isValidHmac = crypto.timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(expectedSignature, 'utf8')
  );

  if (!isValidHmac) {
    return false;
  }

  const [tokenInPayload, expiresAtMsStr] = payload.split(':');
  if (tokenInPayload !== expectedToken) {
    return false;
  }

  const expiresAtMs = Number(expiresAtMsStr);
  if (!expiresAtMs || Date.now() > expiresAtMs) {
    return false;
  }

  return true;
}

