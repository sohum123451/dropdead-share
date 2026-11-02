interface AttemptRecord {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, AttemptRecord>();

export function checkRateLimit(
  key: string,
  maxAttempts: number = 5,
  windowSeconds: number = 900
): { allowed: boolean; attemptsLeft: number; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = attempts.get(key);

  if (!existing || now > existing.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return {
      allowed: true,
      attemptsLeft: maxAttempts - 1,
      retryAfterSeconds: windowSeconds,
    };
  }

  existing.count += 1;
  const remaining = Math.max(0, maxAttempts - existing.count);
  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  if (existing.count > maxAttempts) {
    return {
      allowed: false,
      attemptsLeft: 0,
      retryAfterSeconds: retryAfter,
    };
  }

  return {
    allowed: true,
    attemptsLeft: remaining,
    retryAfterSeconds: retryAfter,
  };
}

