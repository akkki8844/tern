
# Security Architecture

Tern is designed to operate on untrusted source code and untrusted LLM outputs.

## Threat Model

| Threat | Mitigation |
|---|---|
| Path traversal | `sanitizePath` rejects `..` and null bytes; all local file operations use `path.join` + checks. |
| Command injection | `shell: false`, no user input passed as shell arguments; commands use allow-lists. |
| Secret leakage | `redactSecrets` runs on all logs, diffs, sandbox output, and webhook payloads. |
| Unsafe code execution | Patch validator rejects `eval`, `new Function`, `child_process`, `vm`, `spawn`, `exec`. |
| Repository escape | Sandbox copies only code files; max size limits; forbidden file extensions blocked. |
| Token exposure | Tokens are never logged; HMAC signatures are compared with `timingSafeEqual`. |
| LLM prompt injection | User code is truncated and sent as data; system prompts are immutable. |
| Dependency tampering | `npm ci --ignore-scripts` is used; scripts are disabled by default in sandboxes. |
| Auto-merge risk | Tern never auto-merges; every PR requires human review. |

## Secret Detection

`redactSecrets` covers API keys, GitHub tokens, JWTs, private keys, and generic password/secret assignments.

## Patch Validation

The patch validator rejects modifications to lockfiles, CI/CD, Docker, Git configuration, secrets files, package manifests, and build scripts.

## Sandbox

- Network disabled by default.
- `npm ci --ignore-scripts` prevents post-install scripts.
- Secrets redacted in environment and output.
- Timeout, memory, and CPU limits enforced and clamped.
- Ephemeral working directory cleaned up after each run.

## Webhook Verification

GitHub webhook signatures are verified using HMAC-SHA256 with `crypto.timingSafeEqual`.

## Audit

Last security audit: 2026-07-29.
