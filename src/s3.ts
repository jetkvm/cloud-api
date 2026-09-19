import { HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

/** The one R2 client the API process shares between request handlers and background jobs. */
export const s3Client = new S3Client({
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  region: "auto",
});

/** Bucket that holds release artifacts, and the public CDN origin they are served from. */
export const bucketName = process.env.R2_BUCKET!;
export const baseUrl = process.env.R2_CDN_URL!;

/** HeadObject throws NotFound, but some S3-compatible stores (like R2) may throw NoSuchKey. */
export function isS3NotFound(error: any): boolean {
  return (
    error.name === "NotFound" ||
    error.name === "NoSuchKey" ||
    error.$metadata?.httpStatusCode === 404
  );
}

export async function s3ObjectExists(
  client: S3Client,
  bucketName: string,
  key: string,
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch (error: any) {
    if (isS3NotFound(error)) {
      return false;
    }
    throw error;
  }
}

/** True when the version was uploaded with the skus/<sku>/ folder layout. */
export async function versionHasSkuSupport(
  client: S3Client,
  bucketName: string,
  prefix: string,
  version: string,
): Promise<boolean> {
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${prefix}/${version}/skus/`,
      MaxKeys: 1,
    }),
  );
  return (response.Contents?.length ?? 0) > 0;
}
