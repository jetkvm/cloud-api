/*
  Warnings:

  - A unique constraint covering the columns `[secretToken]` on the table `Device` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "secretToken" TEXT,
ADD COLUMN     "tempToken" TEXT,
ADD COLUMN     "tempTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Device_secretToken_key" ON "Device"("secretToken");
