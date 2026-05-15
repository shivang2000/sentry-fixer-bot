import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "@sentry-fixer-bot/env/server";

let cached: S3Client | null = null;

function client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({ region: env.S3_REGION ?? "us-east-1" });
  return cached;
}

/**
 * Put a JSON-serializable payload at s3://$S3_BUCKET/<key>.
 * Returns the s3:// URI so callers can store it on the alert row.
 */
export async function archiveJson(key: string, payload: unknown): Promise<string> {
  const bucket = env.S3_BUCKET;
  if (!bucket) {
    // In dev without an S3 bucket configured, return a sentinel so the alert
    // row still has a non-null raw_payload_s3 reference.
    return `local://${key}`;
  }
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: "application/json",
    }),
  );
  return `s3://${bucket}/${key}`;
}
