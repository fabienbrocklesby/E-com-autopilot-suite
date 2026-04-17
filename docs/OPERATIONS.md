# Operations Guide

Deployment, maintenance, and troubleshooting for the Email Automation system.

---

## Deployment (Dokploy)

The system runs as a Docker Compose stack on the VPS managed by Dokploy.

### Initial deploy

1. Push to the main branch. Dokploy auto-deploys on push (verify webhook is configured in Dokploy settings).
2. Confirm the API is healthy: `GET /health` should return `{"status":"ok"}`.
3. Run migrations manually if the migration runner didn't pick them up:
   ```sh
   docker compose exec api deno run --allow-all api/db/migrate.ts
   ```

### Updating environment variables

1. In Dokploy → App → Environment, add/update the variable.
2. Redeploy the affected service.

Required variables:
- `DATABASE_URL` - Postgres connection string
- `API_SECRET` - Bearer token for all API requests
- `OPENAI_API_KEY` - OpenAI API key
- `ENCRYPTION_KEY` - 32-byte base64 AES key for OAuth token encryption
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - OAuth app credentials
- `GOOGLE_REDIRECT_URI` - Must match the URI registered in Google Cloud Console

---

## Rollback

If a deploy breaks something:

1. In Dokploy, click the previous deployment → **Redeploy** (rolls back containers).
2. If a migration ran and broke things, it must be reverted manually - migrations are append-only and irreversible in general. Contact the developer before rolling back data.

**Never run `git reset --hard` on the production branch.** Revert via a new commit instead.

---

## Inspecting production state

Use read-only DB queries via `docker compose exec`:

```sh
# Connect to Postgres
docker compose exec db psql -U postgres emaildash

# Check active playbook runs
SELECT pr.id, pr.status, pr.current_step_id, t.subject
FROM playbook_runs pr
JOIN threads t ON t.id = pr.thread_id
WHERE pr.status NOT IN ('complete', 'failed', 'escalated')
ORDER BY pr.updated_at DESC
LIMIT 20;

# Check failed runs
SELECT pr.id, pr.status, t.subject, pse.error
FROM playbook_runs pr
JOIN threads t ON t.id = pr.thread_id
LEFT JOIN playbook_step_executions pse ON pse.run_id = pr.id AND pse.status = 'failed'
WHERE pr.status IN ('failed', 'escalated')
ORDER BY pr.updated_at DESC
LIMIT 20;

# Check recent sheet rule executions
SELECT id, status, error, created_at FROM sheet_rule_executions
ORDER BY created_at DESC LIMIT 10;

# Check thread counts by status
SELECT status, count(*) FROM threads GROUP BY status;
```

---

## Gmail OAuth re-authentication

The OAuth tokens expire and need to be refreshed automatically. The `getGoogleAccessToken` service handles this using the stored refresh token.

**If the refresh token is revoked** (user revoked access in Google Account settings, or refresh token expired after 6 months of inactivity):

1. Go to **Settings** → **Connect Google Account** in the dashboard.
2. Complete the OAuth flow. The new tokens are encrypted and stored automatically.
3. Verify with `GET /auth/status` - should return `{ "connected": true, "email": "..." }`.

**If the OAuth flow itself fails**, check:
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct.
- `GOOGLE_REDIRECT_URI` matches exactly what's in Google Cloud Console (including trailing slash, https vs http).
- The Gmail API and Google Sheets API are enabled in the Google Cloud project.

---

## Handling quota limits

### OpenAI

If you see `429` errors from OpenAI:
- The `chatCompletion` function in `api/services/ai.ts` does not auto-retry - errors surface as failed step executions.
- Failed runs stay in `failed` status. Check the Review Queue; the thread will still be in `in_review` for manual handling.
- If quota is repeatedly hit, consider upgrading the OpenAI plan or switching the model in **Settings** → `openai_model` to a cheaper option (e.g. `gpt-4o-mini`).

### Gmail API

Gmail webhook notifications are delivered via Pub/Sub. If the push notification fails, Gmail retries for up to 7 days. No immediate action needed for transient failures.

If the Gmail webhook stops delivering entirely:
1. Check in Google Cloud Console → Pub/Sub → your subscription, that the push endpoint URL is correct and returning 2xx.
2. Re-register the push notification via the API:
   ```
   POST /gmail/watch
   ```
   (This requires the API to be accessible from Google's servers - check firewall rules.)

---

## Migrations

Migrations live in `api/db/migrations/`. They run automatically on startup via `api/db/migrate.ts`.

**Rules:**
- Never edit an applied migration.
- New migration files: `00N_description.sql` where N is the next number.
- Use `TEXT CHECK (col IN (...))` for enum-like columns, not Postgres ENUM types.
- Every migration must be safe to apply on production data.

**To check migration status:**
```sh
docker compose exec db psql -U postgres emaildash -c "SELECT filename, applied_at FROM schema_migrations ORDER BY filename;"
```

---

## Log monitoring

```sh
# Tail API logs
docker compose logs -f api

# Tail with grep for errors
docker compose logs -f api | grep -i "error\|fail\|500"

# Check recent categorisation activity
docker compose logs api | grep "\[categorisation\]\|\[playbook\]\|\[gmail\]" | tail -50
```
