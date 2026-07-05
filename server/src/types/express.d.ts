import type { RequestAuth } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuth;
    }
  }
}

export {};
