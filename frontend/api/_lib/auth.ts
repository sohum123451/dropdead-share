import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const GRANT_SECRET = process.env.GRANT_TOKEN_SECRET || 'dropdead-vercell-secret-key-2026';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPasswordHash(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createDownloadGrantToken(token: string, expiresInSeconds: number = 300): string {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const payload = `${token}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', GRANT_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ token, expiresAt, signature })).toString('base64url');
}

export function verifyDownloadGrantToken(grantToken: string, expectedToken: string): boolean {
  try {
    const raw = Buffer.from(grantToken, 'base64url').toString('utf-8');
    const { token, expiresAt, signature } = JSON.parse(raw);
    if (token !== expectedToken) return false;
    if (Date.now() > expiresAt) return false;
    const expectedSig = crypto
      .createHmac('sha256', GRANT_SECRET)
      .update(`${token}:${expiresAt}`)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

