import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

// Configuration variables
const endpoint = process.env.STORAGE_ENDPOINT;
const bucket = process.env.STORAGE_BUCKET;
const accessKeyId = process.env.STORAGE_KEY;
const secretAccessKey = process.env.STORAGE_SECRET;

// Lazy-loaded S3 client reference
let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!s3Client) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'Missing storage configuration. Please configure STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_KEY, and STORAGE_SECRET in your environment.'
      );
    }

    // Determine region from S3 endpoint (or fallback to standard us-east-1)
    let region = 'us-east-1';
    try {
      const match = endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/);
      if (match && match[1]) {
        region = match[1];
      } else {
        const matchGeneric = endpoint.match(/s3\.([a-z0-9-]+)\./);
        if (matchGeneric && matchGeneric[1]) {
          region = matchGeneric[1];
        }
      }
    } catch (e) {
      // fallback
    }

    s3Client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true, // Often critical for S3-compatible endpoints like Backblaze B2
    });
  }
  return s3Client;
}

/**
 * Uploads a base64 encoded photo/file to the S3-compatible bucket
 * @param base64Data Data-URL or raw base64 string
 * @param prefix Directory prefix (e.g. "photos", "id-proofs")
 * @returns The public access URL for the uploaded file
 */
export async function uploadBase64Image(base64Data: string, prefix: string): Promise<string> {
  if (!base64Data) {
    throw new Error('Base64 content is required for storage upload');
  }

  let cleanBase64 = base64Data;

  // Detect data-uri pattern
  if (base64Data.startsWith('data:')) {
    const parts = base64Data.split(';base64,');
    if (parts.length === 2) {
      cleanBase64 = parts[1];
    }
  }

  const buffer = Buffer.from(cleanBase64, 'base64');

  // Enforce decoded size limit (8MB)
  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error('Maudhui ya picha yamezidi kikomo cha MB 8. / Image size exceeds the 8MB limit.');
  }

  if (buffer.length < 4) {
    throw new Error('Faili batili au tupu. / Invalid or empty file.');
  }

  // Verify magic bytes
  const hex = buffer.subarray(0, 4).toString('hex').toUpperCase();
  let verifiedMime = '';

  if (hex.startsWith('FFD8FF')) {
    verifiedMime = 'image/jpeg';
  } else if (hex === '89504E47') {
    verifiedMime = 'image/png';
  } else if (hex === '47494638') {
    verifiedMime = 'image/gif';
  } else if (hex === '52494646') {
    if (buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      verifiedMime = 'image/webp';
    }
  }

  if (!verifiedMime) {
    throw new Error('Aina ya faili haikubaliki. Tafadhali pakia picha ya JPG, PNG, GIF, au WEBP pekee. / Unsupported file type. Please upload a JPG, PNG, GIF, or WEBP image only.');
  }

  const extension = verifiedMime.split('/')[1] || 'jpg';
  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const key = `${prefix}/${filename}`;

  // Fallback to data URI if storage is not configured (e.g. in development/preview environments)
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.warn(
      `[STORAGE SERVICE] S3 storage configuration is missing. Falling back to data URI for file: ${key}`
    );
    return `data:${verifiedMime};base64,${cleanBase64}`;
  }

  const client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: verifiedMime,
  });

  await client.send(command);

  return key;
}

/**
 * Generates a presigned, expiring URL for a given S3 object key.
 * Valid for exactly 1 hour.
 * @param objectKey The raw object key stored in the database
 */
export async function getSignedPhotoUrl(objectKey: string): Promise<string> {
  if (!objectKey) return '';
  
  // If the objectKey is already a data URI (sandbox fallback) or full HTTP URL, return as is.
  if (objectKey.startsWith('data:') || objectKey.startsWith('http://') || objectKey.startsWith('https://')) {
    return objectKey;
  }

  // If S3 storage is not configured, we cannot generate presigned URLs, so we return the key.
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return objectKey;
  }

  try {
    const client = getS3Client();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    });
    // Securely sign the request to expire in 3600 seconds (1 hour)
    return await getSignedUrl(client as any, command as any, { expiresIn: 3600 });
  } catch (err) {
    console.error(`[STORAGE SERVICE] S3 presigning failed for key: ${objectKey}. Falling back to public link format.`, err);
    const cleanedEndpoint = endpoint!.replace(/\/$/, '');
    return `${cleanedEndpoint}/${bucket}/${objectKey}`;
  }
}
