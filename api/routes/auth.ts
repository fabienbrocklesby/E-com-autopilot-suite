/**
 * Auth route - /auth
 * Implements the Google OAuth 2.0 web server flow using raw fetch calls.
 * Reference: https://developers.google.com/identity/protocols/oauth2/web-server
 */
import { Hono } from "hono";
import { execute, queryOne } from "../db/client.ts";
import { AppError, OAuthToken } from "../types/index.ts";
import { setupGmailWatch, syncLabels } from "../services/gmail.ts";
import {
  encryptToken,
  getGoogleAccessToken,
  isGoogleReconnectRequiredError,
} from "../services/google-auth.ts";

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

// GET /auth/google/start - redirect to Google consent screen
authRouter.get("/google/start", async (c) => {
  if (!CLIENT_ID) throw new AppError(500, "GOOGLE_CLIENT_ID is not configured");

  const state = crypto.randomUUID();

  // Persist the state so the callback can verify it (CSRF protection).
  await execute("INSERT INTO oauth_states (state) VALUES ($1)", [state]);

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

// GET /auth/google/callback - exchange code for tokens
authRouter.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  const state = c.req.query("state");

  if (error) {
    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=${encodeURIComponent(error)}`);
  }

  // Verify CSRF state: must exist in DB and be less than 10 minutes old.
  if (!state) {
    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=missing_state`);
  }
  const storedState = await queryOne<{ state: string; created_at: Date }>(
    "SELECT state, created_at FROM oauth_states WHERE state = $1",
    [state],
  );
  if (!storedState) {
    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=invalid_state`);
  }
  const ageMs = Date.now() - new Date(storedState.created_at).getTime();
  if (ageMs > 10 * 60 * 1000) {
    await execute("DELETE FROM oauth_states WHERE state = $1", [state]);
    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=expired_state`);
  }
  await execute("DELETE FROM oauth_states WHERE state = $1", [state]);

  if (!code) {
    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=missing_code`);
  }

  // Wrap the rest of the flow so any server-side failure (ENCRYPTION_KEY missing,
  // DB error, upstream API error, etc.) redirects to the frontend with a clear
  // error message rather than returning raw JSON at the API origin.
  try {
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
      console.error("[auth] Token exchange failed:", detail);
      return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    if (!tokens.refresh_token) {
      return c.redirect(
        `${FRONTEND_ORIGIN}/settings?oauth_error=${
          encodeURIComponent("no_refresh_token__revoke_app_access_and_retry")
        }`,
      );
    }

    // Fetch the authenticated user's email address.
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) {
      console.error("[auth] Failed to fetch user info:", await userRes.text());
      return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=userinfo_failed`);
    }

    const userInfo = await userRes.json() as { email: string };
    const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Upsert tokens in the database (encrypted). workspace_id defaults to 1 on first connect.
    const encAccess = await encryptToken(tokens.access_token);
    const encRefresh = await encryptToken(tokens.refresh_token!);
    await execute(
      `INSERT INTO oauth_tokens
         (workspace_id, email, expiry, access_token_encrypted, refresh_token_encrypted)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET expiry                  = EXCLUDED.expiry,
             access_token_encrypted  = EXCLUDED.access_token_encrypted,
             refresh_token_encrypted = EXCLUDED.refresh_token_encrypted`,
      [userInfo.email, expiry, encAccess, encRefresh],
    );

    // Resolve which workspace this email belongs to (default = workspace 1).
    const tokenRow = await queryOne<{ workspace_id: number }>(
      "SELECT workspace_id FROM oauth_tokens WHERE email = $1",
      [userInfo.email],
    );
    const workspaceId = tokenRow?.workspace_id ?? 1;

    // Register Gmail push notifications. Fire-and-forget - don't block the redirect.
    setupGmailWatch(userInfo.email).catch((err) =>
      console.error("[auth] Failed to set up Gmail watch:", err)
    );

    // Sync Gmail labels with workspace categories. Fire-and-forget.
    syncLabels(userInfo.email, workspaceId).catch((err) =>
      console.error("[auth] Failed to sync Gmail labels:", err)
    );

    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_success=1`);
  } catch (err) {
    // Log and redirect rather than surfacing raw JSON at the API origin.
    console.error("[auth] OAuth callback error:", err);
    const msg = err instanceof Error ? err.message : "server_error";
    return c.redirect(`${FRONTEND_ORIGIN}/settings?oauth_error=${encodeURIComponent(msg)}`);
  }
});

// GET /auth/status - check whether an OAuth token is stored (protected)
authRouter.get("/status", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== API_SECRET) {
    throw new AppError(401, "Unauthorized");
  }

  const token = await queryOne<Pick<OAuthToken, "email" | "expiry">>(
    "SELECT email, expiry FROM oauth_tokens ORDER BY id DESC LIMIT 1",
  );

  if (!token) {
    return c.json({
      connected: false,
      email: null,
      expiry: null,
      needs_reauth: false,
      error: null,
    });
  }

  let expiry = token.expiry;
  if (new Date(token.expiry).getTime() <= Date.now() + 60_000) {
    try {
      await getGoogleAccessToken(token.email);
      const refreshed = await queryOne<Pick<OAuthToken, "expiry">>(
        "SELECT expiry FROM oauth_tokens WHERE email = $1",
        [token.email],
      );
      expiry = refreshed?.expiry ?? token.expiry;
    } catch (err) {
      if (isGoogleReconnectRequiredError(err)) {
        return c.json({
          connected: false,
          email: token.email,
          expiry: token.expiry,
          needs_reauth: true,
          error: "Google account needs to be reconnected",
        });
      }
      throw err;
    }
  }

  return c.json({
    connected: true,
    email: token.email,
    expiry,
    needs_reauth: false,
    error: null,
  });
});
