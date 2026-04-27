-- CreateTable
CREATE TABLE "ReleaseArtifact" (
    "id" BIGSERIAL NOT NULL,
    "releaseId" BIGINT NOT NULL,
    "url" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "compatibleSkus" TEXT[] NOT NULL,

    CONSTRAINT "ReleaseArtifact_pkey" PRIMARY KEY ("id")
);

-- Backfill one artifact for every existing release.
-- Pre-SKU artifacts only target the original jetkvm-v2 hardware; future SKUs
-- (e.g. jetkvm-v2-sdmmc) require explicit SKU-folder uploads to be registered
-- by scripts/sync-releases.ts.
INSERT INTO "ReleaseArtifact" ("releaseId", "url", "hash", "compatibleSkus")
SELECT
    "id",
    "url",
    "hash",
    ARRAY['jetkvm-v2']::TEXT[]
FROM "Release";

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseArtifact_releaseId_url_key" ON "ReleaseArtifact"("releaseId", "url");

-- AddForeignKey
ALTER TABLE "ReleaseArtifact" ADD CONSTRAINT "ReleaseArtifact_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
