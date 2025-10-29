
import { createHash } from "crypto";
import { type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { InternalServerError } from "./errors";
import { validRange } from "semver";

// Helper function to convert stream to string
export async function streamToString(stream: any): Promise<string> {
  const chunks: Uint8Array[] = [];
  
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  
  const result = Buffer.concat(chunks).toString("utf-8");
  return result.trimEnd();
}
  
// Helper function to convert stream to buffer
export async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
} 

export async function verifyHash(
  file: GetObjectCommandOutput,
  hashFile: GetObjectCommandOutput,
  exception?: string,
): Promise<boolean> {
  const content = await streamToBuffer(file.Body);
  const remoteHash = await streamToString(hashFile.Body);
  const localHash = createHash("sha256").update(content).digest("hex");

  const matches = remoteHash.trim() === localHash;
  if (!matches && exception) {
    throw new InternalServerError(exception);
  }
  return matches;
}

export function toSemverRange(range?: string) {
  if (!range) return "*";
  return validRange(range) || "*";
}