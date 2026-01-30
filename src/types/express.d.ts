declare module "express-serve-static-core" {
  interface Request {
    subject?: string;
    issuer?: string;
  }
}

export {};
