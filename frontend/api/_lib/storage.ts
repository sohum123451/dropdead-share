import { issueSignedToken, presignUrl, del, list } from '@vercel/blob';

const BLOB_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN ||
  'vercel_blob_rw_2oHDFhQdmhqjsVw4_lbrq8NX8HKGbznnTYoNbUtjG7QkWbg';

export async function createUploadPresignedUrl(
  pathname: string
): Promise<{ uploadUrl: string }> {
  const signed = await issueSignedToken({
    token: BLOB_TOKEN,
    pathname,
    access: 'public',
    operations: ['put'],
  });

  const { presignedUrl } = await presignUrl(signed, {
    token: BLOB_TOKEN,
    pathname,
    operation: 'put',
  });

  return { uploadUrl: presignedUrl };
}

export async function findUploadedBlob(
  uploadId: string
): Promise<{ exists: boolean; size?: number; url?: string; downloadUrl?: string }> {
  try {
    const res = await list({ prefix: `uploads/${uploadId}/`, token: BLOB_TOKEN });
    if (res.blobs.length > 0) {
      const b = res.blobs[0];
      return { exists: true, size: b.size, url: b.url, downloadUrl: b.downloadUrl };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

export async function deleteBlob(urlOrPath: string): Promise<void> {
  try {
    await del(urlOrPath, { token: BLOB_TOKEN });
  } catch {
    // Ignore deletion errors for already deleted objects
  }
}

