
# GitHub App Setup

1. Create a GitHub App in Settings -> Developer Settings.
2. Set webhook URL to `https://your-domain/api/webhooks/github`.
3. Permissions: Contents (read/write), Metadata (read), Pull Requests (read/write).
4. Events: Installation, Repository, Pull Request.
5. Download private key and set environment variables.
