/**
 * Central error-handling middleware for Hono.
 * Catches AppError instances and generic errors, returning a consistent JSON
 * envelope so every error response has the same shape.
 */
import type { Context, Next } from "npm:hono";
import { AppError } from "../types/index.ts";

export interface ErrorResponse {
  error: {
    message: string;
    detail?: string;
    status: number;
  };
}

/**
 * Wraps each route handler so that any thrown error is caught and serialised
 * as JSON. Must be registered before route handlers with `app.use("*", ...)`.
 */
export async function errorMiddleware(c: Context, next: Next): Promise<Response | void> {
  try {
    await next();
  } catch (err) {
    if (err instanceof AppError) {
      const body: ErrorResponse = {
        error: {
          message: err.message,
          detail: err.detail,
          status: err.statusCode,
        },
      };
      return c.json(body, err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500);
    }

    // Unexpected error — log it and return a generic 500.
    console.error("[error]", err);

    const body: ErrorResponse = {
      error: {
        message: "Internal server error",
        status: 500,
      },
    };
    return c.json(body, 500);
  }
}
