-- CreateTable
CREATE TABLE "User" (
    "id" BIGSERIAL NOT NULL,
    "googleId" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Kvm" (
    "id" BIGSERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT,
    "userId" BIGINT NOT NULL,

    CONSTRAINT "Kvm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "Kvm_deviceId_key" ON "Kvm"("deviceId");

-- AddForeignKey
ALTER TABLE "Kvm" ADD CONSTRAINT "Kvm_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
