
# Security

- Secrets are redacted from logs.
- Tokens are encrypted at rest when `ENCRYPTION_KEY` is provided.
- Webhooks are verified with HMAC-SHA256.
- Only affected code snippets are sent to the LLM.
- Sandboxes are ephemeral and isolated.
- Patches are validated for forbidden patterns and size limits.
- Audit logs are immutable.
