# GitHub App setup

Tern uses a GitHub App for **all** repository access. Personal access tokens are not
supported anywhere in the codebase.

## 1. Create the App

Settings → Developer settings → GitHub Apps → New GitHub App.

* **Homepage URL**: your deployment's base URL
* **Webhook URL**: `https://your-domain/api/webhooks/github`
* **Webhook secret**: generate at least 16 random characters and keep it — this becomes
  `GITHUB_WEBHOOK_SECRET`. Tern rejects every delivery whose HMAC does not match.

## 2. Permissions

| Permission | Level | Why |
| --- | --- | --- |
| Repository → Contents | Read and write | Read the specification and source; create the migration branch and commit |
| Repository → Metadata | Read | Mandatory for any App |
| Repository → Pull requests | Read and write | Open the draft pull request |

Do **not** grant Administration, Actions or Secrets. Tern does not use them.

## 3. Subscribe to events

* `Push` — triggers analysis when the specification changes on the default branch
* `Installation` and `Installation repositories` — keeps the installed repository list current
* `Pull request` — records when a human merges or closes a Tern pull request

## 4. Private key

Generate a private key and download the `.pem`. Provide it as `GITHUB_PRIVATE_KEY`
either as PEM text, PEM with literal `\n` escapes, or base64-encoded — the configuration
loader accepts all three and validates the result.

## 5. Environment

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=a-long-random-string
```

All three are required together. Setting only some of them is a configuration error, not
a silent downgrade.

## 6. Optional: user sign-in

Sign-in is a **separate** OAuth App (or the App's own OAuth credentials) used only to
identify people in the dashboard. Its scope is `read:user`; it can never read
repository contents.

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
SESSION_SECRET=at-least-32-random-characters
PUBLIC_BASE_URL=https://your-domain
```

Set the OAuth callback URL to `https://your-domain/api/auth/github/callback`.

## 7. Verify

```bash
curl -s https://your-domain/api/health/detailed | jq
```

`checks[].name == "github"` reports `degraded` until the App credentials are present.
