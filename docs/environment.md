
# Environment

Copy `.env.example` to `.env` and configure the variables below.

## Required

- `DATABASE_URL` — PostgreSQL connection string.
- `REDIS_URL` — Redis connection string for BullMQ.
- `GITHUB_APP_ID` — GitHub App ID.
- `GITHUB_PRIVATE_KEY` — Base64-encoded GitHub App private key.
- `GITHUB_WEBHOOK_SECRET` — Secret for webhook signature verification.

## Optional

- `FIREWORKS_API_KEY` — API key for Fireworks LLM fallback.
- `FIREWORKS_BASE_URL` — Defaults to `https://api.fireworks.ai/inference/v1`.
- `FIREWORKS_MODEL` — Defaults to `accounts/fireworks/models/llama-v3p1-70b-instruct`.
- `SANDBOX_TIMEOUT_MS` — Default sandbox timeout.
- `SANDBOX_MEMORY_MB` — Default sandbox memory limit.
- `SANDBOX_CPU_LIMIT` — Default sandbox CPU limit.
- `LOG_LEVEL` — `debug`, `info`, `warn`, `error`.
- `NODE_ENV` — `development`, `test`, `production`.

## Secrets

All secrets are redacted from logs and sandbox output. Never commit `.env` files.
