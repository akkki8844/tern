
# Deployment

## Docker Compose

```bash
npm run docker:build
npm run docker:up
```

## Environment

Set all required production variables in `.env`:

```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY=...
GITHUB_WEBHOOK_SECRET=...
FIREWORKS_API_KEY=...
NEXTAUTH_SECRET=...
ENCRYPTION_KEY=...
```

## Health

- `GET /api/health` — basic health
- `GET /api/health/detailed` — full component health

## Security

See `docs/security.md`.
