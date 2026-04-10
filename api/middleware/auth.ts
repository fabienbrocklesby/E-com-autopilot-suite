/**
 * Auth middleware.
 * Validates the API_SECRET token passed in the Authorization header for
 * protected routes. Bearer token format: "Authorization: Bearer <secret>".
 *
 * The OAuth callback endpoints are intentionally excluded from this check —
 * they rely on the Google OAuth state parameter for CSRF protection.
 */
import type { Context, Next } from "npm:hono";
import { AppError } from "../types/index.ts";

const API_SECRET = Deno.env.get("API_SECRET") ?? "";

/**
 * Middleware that rejects requests without a valid Bearer token.
 * Attach to route groups that require authentication.
 */
export async function authMiddleware(c: Context, next: Next): Promise<void> {
  if (!API_SECRET) {
    throw new AppError(500, "Server misconfiguration: API_SECRET is not set");
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError(401, "Missing or malformed Authorization header");
  }

  const token = authHeader.slice(7);
  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(token, API_SECRET)) {
    throw new AppError(401, "Invalid token");
  }

  await next();
}

/** Constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
