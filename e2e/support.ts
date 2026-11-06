import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Shared by global setup and the tests. Nothing here may call inject(), which
// only works inside the test runner.

export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

export function s3Client(endpoint: string) {
  return new S3Client({
    endpoint,
    region: "auto",
    credentials: { accessKeyId: "e2e", secretAccessKey: "e2e" },
  });
}

/** Uploads an artifact and its .sha256 sidecar, as the release script does. */
export async function putArtifact(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
) {
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body })),
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${key}.sha256`,
        Body: `${sha256(body)}\n`,
      }),
    ),
  ]);
}

/** POST /releases/sync as the upload script calls it. */
export function postSync(apiUrl: string, token: string, body?: object) {
  return fetch(`${apiUrl}/releases/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
