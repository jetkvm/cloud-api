-- CreateTable
CREATE TABLE "TurnActivity" (
    "id" BIGSERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "bytesSent" INTEGER NOT NULL,
    "bytesReceived" INTEGER NOT NULL,

    CONSTRAINT "TurnActivity_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TurnActivity" ADD CONSTRAINT "TurnActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
