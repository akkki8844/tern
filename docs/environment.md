# Environment reference

Capibara reads configuration in exactly one place: `packages/shared/src/config.ts`.
Nothing else in the codebase touches `process.env` — an ESLint rule (`no-restricted-syntax`)
fails the build if it tries.

Configuration is parsed and validated with zod at process start. A misconfigured
deployment fails immediately with a message that lists **every** problem at once, for
example:

```
Capibara configuration is invalid (2 problems):
  - DATABASE_URL is required. Example: postgresql://user:pass@localhost:5432/capibara
  - WORKER_HEARTBEAT_INTERVAL_MS (30000) must be smaller than WORKER_LEASE_DURATION_MS (20000)
See docs/environment.md for the full reference.
```

Secrets are wrapped in a `Secret` object. `String(secret)`, `${secret}`,
`JSON.stringify(secret)` and `util.inspect(secret)` all produce `[REDACTED]`; the value
is only reachable through an explicit `.reveal()` call, which makes every use greppable.

## Runtime modes

| Mode | How | Effect |
| --- | --- | --- |
| development | `NODE_ENV=development` (default) | Relaxed requirements; real providers used when configured |
| test | `NODE_ENV=test` | Never contacts external services |
| production | `NODE_ENV=production` | GitHub App credentials are mandatory unless demo mode is on |
| demo | `CAPIBARA_MODE=demo` (or `DEMO_MODE=true`) | Every external provider is replaced by an in-memory one |

## Variables

### Core

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | no | no | `development` \| `test` \| `production`. Defaults to `development`. |
| `CAPIBARA_MODE` | no | no | `real` (default) or `demo`. |
| `DEMO_MODE` | no | no | Legacy alias for `CAPIBARA_MODE=demo`. |
| `LOG_LEVEL` | no | no | `trace`…`fatal` or `silent`. Defaults to `info`. |
| `LOG_PRETTY` | no | no | Human-readable logs. Forced off in production. |
| `SERVICE_NAME` | no | no | Attached to every log line. Defaults to `capibara`. |

### Database

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | **always** | yes | PostgreSQL connection string. Must start with `postgresql://`. |
| `DATABASE_POOL_SIZE` | no | no | 1–100, defaults to 10. |

### GitHub App — the only credential allowed to touch repositories

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | production | no | Numeric App id. |
| `GITHUB_PRIVATE_KEY` | production | yes | PEM, PEM with literal `\n`, or base64-encoded PEM. |
| `GITHUB_WEBHOOK_SECRET` | production | yes | Minimum 16 characters. |
| `GITHUB_API_BASE_URL` | no | no | Override for GitHub Enterprise. |

Setting *any* of the three App variables requires all three: a half-configured App is a
configuration error, never a silent downgrade to demo mode.

### GitHub OAuth — user identity only

Kept deliberately separate from App auth. The OAuth scope is `read:user`; these
credentials can never be used to read or write repository contents.

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `GITHUB_CLIENT_ID` | no | no | Enables sign-in when set together with the secret. |
| `GITHUB_CLIENT_SECRET` | no | yes | Required when the client id is set. |
| `SESSION_SECRET` | no | yes | Minimum 32 characters. Required when OAuth is enabled. |
| `PUBLIC_BASE_URL` | no | no | Externally reachable base URL, used to build the redirect URI. |

### Fireworks AI — optional fallback

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `FIREWORKS_API_KEY` | no | yes | When absent the AI fallback is **disabled** and migrations stay deterministic. |
| `FIREWORKS_BASE_URL` | no | no | Defaults to the public inference endpoint. |
| `FIREWORKS_MODEL` | no | no | Model identifier. |
| `FIREWORKS_TIMEOUT_MS` | no | no | Per-request hard timeout, 1 000–600 000. Defaults to 60 000. |
| `FIREWORKS_MAX_ATTEMPTS` | no | no | 1–10. Defaults to 3. |
| `FIREWORKS_MAX_PROMPT_CHARS` | no | no | Hard cap on characters sent per request. Defaults to 24 000. |

### Worker

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `WORKER_CONCURRENCY` | no | no | Jobs in flight per worker, 1–64. Defaults to 2. |
| `WORKER_POLL_INTERVAL_MS` | no | no | Idle poll interval. Defaults to 2 000. |
| `WORKER_LEASE_DURATION_MS` | no | no | Lease length for a claimed job. Defaults to 60 000. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | no | no | Lease renewal interval. **Must be smaller than the lease.** Defaults to 15 000. |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | no | no | Grace period for in-flight jobs on SIGTERM. Defaults to 30 000. |
| `WORKER_ID` | no | no | Defaults to `${hostname}-${pid}`. |

### Workspaces and sandbox

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `WORKSPACE_ROOT` | no | no | Absolute directory containing one isolated directory per job. |
| `WORKSPACE_MAX_BYTES` | no | no | Advisory per-workspace size budget. |
| `SANDBOX_TIMEOUT_MS` | no | no | Default command timeout. |
| `SANDBOX_MEMORY_MB` | no | no | Advisory memory limit. |
| `SANDBOX_CPU_LIMIT` | no | no | Advisory CPU limit. |

### Other

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `CAPIBARA_DEMO_REPO_PATH` | no | no | Local repository used as the checkout source in demo mode. |
| `ENCRYPTION_KEY` | no | yes | AES-256-GCM key material for future at-rest encryption. Minimum 32 characters. |
| `CAPIBARA_TEST_DATABASE_URL` | no | yes | When set, the multi-connection job concurrency suite runs against this database. |

## Checking configuration

`loadConfig()` is pure and takes an explicit environment, so configuration is unit
tested rather than inspected by hand — see `packages/shared/src/config.test.ts`.
