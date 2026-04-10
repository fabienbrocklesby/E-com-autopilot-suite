/**
 * Auth route — /auth
 * Implements the Google OAuth 2.0 web server flow using raw fetch calls.
 * Reference: https://developers.google.com/identity/protocols/oauth2/web-server
 */
import { Hono } from "hono";
import { queryOne, execute } from "../db/client.ts";
import { AppError, OAuthToken } from "../types/index.ts";
import { setupGmailWatch } from "../services/gmail.ts";

export const authRouter = new Hono();

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const API_BASE_URL = Deno.env.get("API_BASE_URL") ?? "http://localhost:8000";
const FRONTEND_ORIGIN = Deno.env.get("FRONTEND_ORIGIN") ?? "http://localhost:3000";
const API_SECRET = Deno.env.get("API_SECRET") ?? "";

const REDIRECT_URI = `${API_BASE_URL}/auth/google/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/spreadsheets",
  "email",
  "profile",
].join(" ");

// GET /auth/google/start — redirect to Google consent screen
authRouter.get("/google/start", (c) => {
  if (!CLIENT_ID) throw new AppError(500, "GOOGLE_CLIENT_ID is not configured");

  // Use a random state parameter to prevent CSRF.
  // In production this should be stored in a short-lived server-side session.
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "select_account consent",
    state,
  });

  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

// GET /auth/google/callback — exchange code for tokens
authRouter.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");

  if (error) {
    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=${encodeURIComponent(error)}`);
  }

  if (!code) throw new AppError(400, "Missing authorization code");

  // Exchange the authorization code for tokens.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    throw new AppError(502, "Failed to exchange authorization code", detail);
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  if (!tokens.refresh_token) {
    throw new AppError(400, "No refresh token returned. Revoke app access and try again.");
  }

  // Fetch the authenticated user's email address.
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) {
    throw new AppError(502, "Failed to fetch user info from Google");
  }

  const userInfo = await userRes.json() as { email: string };
  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Upsert tokens in the database.
  await execute(
    `INSERT INTO oauth_tokens (email, access_token, refresh_token, expiry)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET access_token  = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expiry        = EXCLUDED.expiry`,
    [userInfo.email, tokens.access_token, tokens.refresh_token, expiry],
  );

  // Register Gmail push notifications. Fire-and-forget — don't block the redirect.
  setupGmailWatch(userInfo.email).catch((err) =>
    console.error("[auth] Failed to set up Gmail watch:", err)
  );

  return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_success=1`);
});

// GET /auth/status — check whether an OAuth token is stored (protected)
authRouter.get("/status", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== API_SECRET) {
    throw new AppError(401, "Unauthorized");
  }

  const token = await queryOne<Pick<OAuthToken, "email" | "expiry">>(
    "SELECT email, expiry FROM oauth_tokens ORDER BY id DESC LIMIT 1",
  );

  return c.json({
    connected: token !== null,
    email: token?.email ?? null,
    expiry: token?.expiry ?? null,
  });
});
