
# Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| NODE_ENV | no | development | development, production, or test |
| PORT | no | 3000 | Web port |
| DATABASE_URL | yes | postgresql://... | PostgreSQL connection string |
| REDIS_URL | yes | redis://localhost:6379 | Redis connection string |
| GITHUB_APP_ID | production | - | GitHub App ID |
| GITHUB_PRIVATE_KEY | production | - | GitHub App private key PEM |
| GITHUB_WEBHOOK_SECRET | no | demo-secret | Webhook secret |
| FIREWORKS_API_KEY | production | - | Fireworks AI API key |
| NEXTAUTH_SECRET | no | demo-nextauth-secret | NextAuth secret |
| ENCRYPTION_KEY | recommended | - | AES-256 key (hex) |
| DEMO_MODE | no | false | Run without real credentials |
