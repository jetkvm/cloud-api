-- CreateTable
CREATE TABLE "Release" (
    "id" BIGSERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "rolloutPercentage" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'firmware',

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Release_version_type_key" ON "Release"("version", "type");
