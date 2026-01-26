import { beforeAll, afterAll, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";

// Load .env.development for config
config({ path: ".env.development" });

// Use compose.yaml database credentials (jetkvm user, not postgres)
process.env.DATABASE_URL = "postgresql://jetkvm:jetkvm@localhost:5432/jetkvm?schema=public";

// Override S3 config for testing (mock responses)
process.env.NODE_ENV = "test";
process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
process.env.R2_ACCESS_KEY_ID = "test-access-key";
process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
process.env.R2_BUCKET = "test-bucket";
process.env.R2_CDN_URL = "https://cdn.test.com";

// Create S3 mock that can be used across tests
export const s3Mock = mockClient(S3Client);

// Create a test Prisma client
export const testPrisma = new PrismaClient();

function ensureSafeTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for tests");
  }

  const parsed = new URL(databaseUrl);
  const host = parsed.hostname;
  const dbName = parsed.pathname.replace(/^\//, "");

  const isLocalHost = host === "localhost" || host === "127.0.0.1";
  const isTestDb = dbName === "jetkvm" || dbName.includes("test");

  if (!isLocalHost || !isTestDb) {
    throw new Error(
      `Unsafe DATABASE_URL for tests: ${databaseUrl}. Refusing to run destructive test setup.`,
    );
  }
}

// Seed data for releases
export const seedReleases = [
  // App releases
  {
    version: "1.0.0",
    type: "app",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/app/1.0.0/jetkvm_app",
    hash: "abc123hash100",
  },
  {
    version: "1.1.0",
    type: "app",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/app/1.1.0/jetkvm_app",
    hash: "abc123hash110",
  },
  {
    version: "1.2.0",
    type: "app",
    rolloutPercentage: 10,
    url: "https://cdn.test.com/app/1.2.0/jetkvm_app",
    hash: "abc123hash120",
  },
  // System releases
  {
    version: "1.0.0",
    type: "system",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/system/1.0.0/system.tar",
    hash: "sys123hash100",
  },
  {
    version: "1.1.0",
    type: "system",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/system/1.1.0/system.tar",
    hash: "sys123hash110",
  },
  {
    version: "1.2.0",
    type: "system",
    rolloutPercentage: 10,
    url: "https://cdn.test.com/system/1.2.0/system.tar",
    hash: "sys123hash120",
  },
];

// Helper to set rollout percentage for a specific version
export async function setRollout(version: string, type: "app" | "system", percentage: number) {
  await testPrisma.release.upsert({
    where: { version_type: { version, type } },
    update: { rolloutPercentage: percentage },
    create: {
      version,
      type,
      rolloutPercentage: percentage,
      url: `https://cdn.test.com/${type}/${version}/${type === "app" ? "jetkvm_app" : "system.tar"}`,
      hash: `test-hash-${version}-${type}`,
    },
  });
}

// Helper to reset all releases to seed data baseline
export async function resetToSeedData() {
  // Delete any releases not in seed data
  const seedVersionTypes = seedReleases.map(r => ({ version: r.version, type: r.type }));
  await testPrisma.release.deleteMany({
    where: {
      NOT: {
        OR: seedVersionTypes.map(vt => ({
          version: vt.version,
          type: vt.type,
        })),
      },
    },
  });

  // Reset seed releases to original values
  for (const release of seedReleases) {
    await testPrisma.release.upsert({
      where: { version_type: { version: release.version, type: release.type } },
      update: { rolloutPercentage: release.rolloutPercentage, url: release.url, hash: release.hash },
      create: release,
    });
  }
}

// Helper to create a readable stream from a string (for S3 mock responses)
export function createMockStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

// Helper to create async iterable from string (for streamToString/streamToBuffer)
export function createAsyncIterable(content: string | Buffer) {
  const data = typeof content === "string" ? Buffer.from(content) : content;
  return {
    async *[Symbol.asyncIterator]() {
      yield data;
    },
  };
}

beforeAll(async () => {
  ensureSafeTestDatabase();

  // Connect to the test database
  await testPrisma.$connect();

  // Clean up existing releases
  await testPrisma.release.deleteMany({});

  // Seed the database with test releases
  for (const release of seedReleases) {
    await testPrisma.release.create({ data: release });
  }
});

afterEach(() => {
  // Reset S3 mock after each test
  s3Mock.reset();
  // Reset DB to seed state after each test to avoid cross-test coupling
  return resetToSeedData();
});

afterAll(async () => {
  // Clean up after all tests
  await testPrisma.release.deleteMany({});
  await testPrisma.$disconnect();
});
