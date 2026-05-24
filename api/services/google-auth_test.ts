import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isGoogleReconnectRequiredError, isGoogleRefreshGrantInvalid } from "./google-auth.ts";
import { AppError } from "../types/index.ts";

Deno.test("isGoogleRefreshGrantInvalid detects invalid_grant JSON without relying on description", () => {
  const detail = '{\n  "error": "invalid_grant",\n  "error_description": "Bad Request"\n}';

  assertEquals(isGoogleRefreshGrantInvalid(detail), true);
});

Deno.test("isGoogleRefreshGrantInvalid ignores unrelated OAuth errors", () => {
  const detail = '{ "error": "temporarily_unavailable" }';

  assertEquals(isGoogleRefreshGrantInvalid(detail), false);
});

Deno.test("isGoogleReconnectRequiredError detects AppError invalid_grant failures", () => {
  const err = new AppError(
    401,
    "Google account needs to be reconnected",
    '{"error":"invalid_grant"}',
  );

  assertEquals(isGoogleReconnectRequiredError(err), true);
});
