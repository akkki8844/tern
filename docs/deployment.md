
# Deployment

## Requirements

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Docker (optional, for sandbox)
- GitHub App credentials

## Environment

Copy `.env.example` to `.env` and configure the required variables.

See [docs/environment.md](docs/environment.md) for details.

## Docker Compose

```bash
npm run docker:up
```

This starts PostgreSQL, Redis, the web app, and the worker.

## GitHub App Setup

1. Create a GitHub App at https://github.com/settings/apps/new
2. Set the webhook URL to `https://your-domain.com/api/webhooks/github`
3. Enable pull request and push event permissions
4. Install the app on your repositories
5. Set `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`

## Production Checklist

- [ ] Rotate secrets and store them in a secret manager
- [ ] Enable TLS on the web app
- [ ] Configure resource limits for the worker
- [ ] Set up monitoring and alerting
- [ ] Run the full test suite
- [ ] Review the security documentation
