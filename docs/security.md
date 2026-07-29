
# Security Architecture

Tern is designed to operate on untrusted source code and untrusted LLM outputs. The following sections document every security decision and safeguard.

## Threat Model

| Threat | Mitigation |
|---|---|
| Path traversal | `sanitizePath` rejects `..` and all local file operations use `path.resolve` + checks. |
| Command injection | `shell: false`, no user input passed as shell arguments; all commands use allow-lists. |
| Secret leakage | `redactSecrets` runs on all logs, diffs, sandbox output, and webhook payloads. |
| Unsafe code execution | Patch validator rejects `eval`, `new Function`, `child_process`, `vm`, `spawn`, `exec`. |
| Repository escape | Sandbox copies only code files; max size limits; forbidden file extensions blocked. |
| Token exposure | Tokens are never logged; HMAC signatures are compared in constant time. |
| LLM prompt injection | User code is truncated and sent as data; system prompts are immutable. |
| Dependency tampering | `npm ci --ignore-scripts` is used; scripts are disabled by default in sandboxes. |
| Auto-merge risk | Tern never auto-merges; every PR requires human review. |

## Secret Detection

`redactSecrets` covers:
- OpenAI-style keys `sk-...`
- GitHub tokens `ghp_...`, `gho_...`, `ghs_...`, `ghu_...`, `ghr_...`
- JWT tokens
- Private keys in PEM format
- Generic password/secret/api-key assignments

## Patch Validation

The patch validator rejects modifications to:
- Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`)
- CI/CD configuration (`.github/workflows`, `.gitlab-ci.yml`, etc.)
- Docker configuration (`Dockerfile`, `docker-compose.yml`)
- Git configuration (`.gitignore`, `.gitmodules`, `.gitconfig`)
- Secrets files (`.env`, `.pem`, `.key`, `.p12`)
- Package manifests (`package.json`)
- Build scripts (`Makefile`, `CMakeLists.txt`)

Allowed file extensions are limited to source code, JSON, markdown, and YAML required by the application.

## Sandbox

- Network disabled by default.
- `npm ci --ignore-scripts` prevents post-install scripts.
- Secrets redacted in environment and output.
- Timeout, memory, and CPU limits enforced.
- Ephemeral working directory cleaned up after each run.

## Webhook Verification

GitHub webhook signatures are verified using HMAC-SHA256 with constant-time comparison to prevent timing attacks.

## Audit

Last security audit: 2026-07-29.
