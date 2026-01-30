import { PrismaClient } from "@prisma/client";

let prismaClient: PrismaClient;
declare global {
  var __db: PrismaClient | undefined;
}

// This is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
if (process.env.NODE_ENV !== "development") {
  prismaClient = new PrismaClient();
  prismaClient.$connect();
} else {
  if (!global.__db) {
    global.__db = new PrismaClient();
    global.__db.$connect();
  }
  prismaClient = global.__db;
}

// Have to cast it manually, because webstorm can't infer it for some reason
// https://github.com/prisma/prisma/issues/2359#issuecomment-963340538
export const prisma = prismaClient;
