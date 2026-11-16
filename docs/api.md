# HTTP API

All endpoints live in `apps/web/app/api`. Every response carries the security headers
set by `apps/web/middleware.ts`.

Errors use a stable shape and never leak internals:

```json
{ "error": { "code": "WEBHOOK_SIGNATURE_INVALID", "category": "AUTHENTICATION", "message": "Signature verification failed." } }
```

## `POST /api/webhooks/github`

Receives GitHub App webhook deliveries.

| Header | Required |
| --- | --- |
| `X-Hub-Signature-256` | yes |
| `X-GitHub-Event` | yes |
| `X-GitHub-Delivery` | yes |

| Status | Meaning |
| --- | --- |
| 202 | Accepted (`{"status":"accepted","deliveryId","jobId"}`), duplicate, or ignored event |
| 400 | Malformed body, payload or headers |
| 401 | Signature verification failed |
| 413 | Body larger than 25 MiB |
| 429 | Rate limited |
| 500 | Internal failure |

The endpoint verifies, de-duplicates, persists a reduced summary and enqueues a job. It
performs no pipeline work inline.

## `GET /api/auth/github`

Starts GitHub OAuth for **user identity only** (`read:user`). Sets a short-lived
HttpOnly `state` cookie and redirects to GitHub. Returns 503 when OAuth is not
configured.

## `GET /api/auth/github/callback`

Verifies `state` in constant time, exchanges the code, reads the profile, upserts the
user and issues a session cookie, then redirects to `/dashboard`. The GitHub user token
is discarded immediately. Returns 401 on any authentication failure.

## `POST /api/auth/logout`

Revokes the current session and clears the cookie. POST-only.

## `GET /api/auth/session`

Returns `{ "user": { id, githubId, login, name, avatarUrl } }`, or 401.

## `GET /api/health`

Liveness. Does not touch the database.

```json
{ "status": "healthy", "service": "tern", "demoMode": false, "timestamp": "..." }
```

## `GET /api/health/detailed`

Readiness. Actually checks each dependency (database connectivity, job queue depth,
GitHub configuration) with a per-check timeout.

* 200 when healthy or degraded
* 503 when any check is unhealthy

```json
{
  "status": "degraded",
  "checks": [
    { "name": "database", "status": "healthy", "latencyMs": 3 },
    { "name": "jobs", "status": "healthy", "latencyMs": 4, "message": "0 pending, 1 running" },
    { "name": "github", "status": "degraded", "latencyMs": 0, "message": "GitHub App is not configured" }
  ],
  "demoMode": false,
  "timestamp": "..."
}
```
