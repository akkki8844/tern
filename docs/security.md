
# Security

## Secret Redaction
All logs and LLM prompts are passed through `redactSecrets` to remove tokens, API keys, passwords, and private keys.

## Encryption
When `ENCRYPTION_KEY` is set, tokens are encrypted with AES-256-CBC before storage. Without the key, the app stores plaintext tokens only in development.

## Webhook Verification
GitHub webhook signatures are verified using HMAC-SHA256.

## Patch Validation
Patches are validated before sandbox execution:
- Allowed file extensions only
- Forbidden patterns (eval, child_process, secrets, lockfile modifications)
- Maximum 500 lines changed
- No suspicious environment modifications

## LLM Safety
Only affected code snippets and OpenAPI diff summaries are sent to the LLM. Full repositories and secrets are never transmitted.

## Audit
All actions are recorded with actor, action, resource, resourceId, timestamp, and metadata. Logs are immutable.

## Rate Limiting
API endpoints are rate limited per client IP.

## Sandboxing
Code is tested in an ephemeral directory or a Docker container with CPU, memory, and timeout limits.
