import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

let s3Client: S3Client | null = null;

function getBucketName(): string {
  const bucket = process.env.S3_BUCKET_NAME?.trim();
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME environment variable is required.");
  }
  return bucket;
}

export function getS3Client(): S3Client {
  if (!s3Client) {
    const region = process.env.AWS_REGION?.trim();
    if (!region) {
      throw new Error("AWS_REGION environment variable is required.");
    }

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables are required."
      );
    }

    s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return s3Client;
}

export function isS3Key(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) return false;
  if (value.startsWith("/uploads/")) return false;
  return true;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    throw new Error("S3 object body is empty.");
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Unsupported S3 object body type.");
}

export async function uploadObject(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  const client = getS3Client();
  const bucket = getBucketName();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const client = getS3Client();
  const bucket = getBucketName();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return streamToBuffer(response.Body);
}

export async function getPresignedGetUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  const client = getS3Client();
  const bucket = getBucketName();

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn: expiresInSeconds }
  );
}
