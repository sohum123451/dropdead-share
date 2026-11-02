import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from '../config/logger';

export const s3Client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

export const S3_BUCKET = env.S3_BUCKET;

logger.info(
  {
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  },
  'S3 Client initialized'
);

/**
 * Generates a pre-signed PUT URL for direct client-to-S3 uploads.
 * Binds ContentType and ContentLength into the signature and defaults to 10 minutes validity.
 */
export async function createPresignedUploadUrl(
  key: string,
  contentType: string,
  contentLength: number,
  expiresInSeconds: number = 600
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(s3Client, command, {
    expiresIn: expiresInSeconds,
    signableHeaders: new Set(['content-type', 'content-length', 'host']),
  });
}

/**
 * Retrieves object metadata from S3 via HEAD request.
 */
export async function getObjectMetadata(
  key: string
): Promise<{ exists: boolean; size?: number; contentType?: string }> {
  try {
    const res = await s3Client.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      })
    );
    return {
      exists: true,
      size: res.ContentLength,
      contentType: res.ContentType,
    };
  } catch (err: unknown) {
    return { exists: false };
  }
}

/**
 * Generates a short-lived (60s) pre-signed GET URL for direct file downloads.
 */
export async function createPresignedDownloadUrl(
  key: string,
  downloadFilename: string,
  expiresInSeconds: number = 60
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(downloadFilename)}"`,
  });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Verifies object existence in storage.
 */
export async function checkObjectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      })
    );
    return true;
  } catch (err: unknown) {
    return false;
  }
}

/**
 * Deletes an object from storage when link self-destructs.
 */
export async function deleteStorageObject(key: string): Promise<void> {
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      })
    );
    logger.info({ key }, 'Deleted S3 object for dead link');
  } catch (err) {
    logger.error({ err, key }, 'Failed to delete S3 object');
  }
}
