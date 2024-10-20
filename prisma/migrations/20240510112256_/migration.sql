/*
  Warnings:

  - You are about to drop the `Kvm` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Kvm" DROP CONSTRAINT "Kvm_userId_fkey";

-- DropTable
DROP TABLE "Kvm";

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "lastSeen" TIMESTAMP(6),
    "name" TEXT,
    "userId" BIGINT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_id_key" ON "Device"("id");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
