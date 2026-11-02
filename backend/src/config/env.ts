import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_PATH: z.string().default('./data/metadata.db'),
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_BUCKET: z.string().min(1).default('file-share'),
  S3_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('minioadmin'),
  AWS_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .default('true'),
  MAX_FILE_MB: z.coerce.number().positive().default(1024),
  GRANT_TOKEN_SECRET: z.string().default('file-share-secret-grant-token-key-2026'),
  CLEANUP_CRON_SCHEDULE: z.string().default('*/5 * * * *'),
  BASE_URL: z
    .preprocess((val) => {
      if (!val || val === '/' || typeof val !== 'string') return 'http://localhost:3000';
      if (!val.startsWith('http://') && !val.startsWith('https://')) return 'http://localhost:3000';
      return val;
    }, z.string().url())
    .default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Use stderr directly since logger might depend on env
  process.stderr.write(`Invalid environment configuration: ${JSON.stringify(parsed.error.format())}\n`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  DATABASE_ABSOLUTE_PATH: path.isAbsolute(parsed.data.DATABASE_PATH)
    ? parsed.data.DATABASE_PATH
    : path.resolve(process.cwd(), parsed.data.DATABASE_PATH),
};
