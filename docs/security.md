# Security

This document describes the controls that exist in the code today, and the limits of
those controls. Anything not implemented is listed under "Known gaps" rather than
described as if it were done.

## Secrets

* Every configured secret is wrapped in `Secret` (`packages/shared/src/secret.ts`).
  Interpolation, `String()`, `JSON.stringify` and `util.inspect` all yield
  `[REDACTED]`. The value is reachable only through `.reveal()`.
* All structured log context passes through `redactValue`
  (`packages/shared/src/redaction.ts`), which redacts by key name *and* scans string
  values for credential patterns (GitHub tokens, `fw_`/`sk-` keys, AWS key ids, JWTs,
  PEM private keys, `postgres://user:pass@` URLs).
* Long strings are truncated before logging, so repository content cannot flood the log
  pipeline.
* Subprocess output is redacted before it is returned, logged or persisted.
* Provider error bodies are redacted before they are attached to an error. There is a
  test asserting that an API key echoed back in a 400 body never reaches the error.
* No secret is ever written to the database. Installation tokens are minted per use;
  OAuth user tokens are used once to read the profile and discarded.

## Webhooks

* HMAC-SHA256 is computed over the exact raw bytes GitHub sent, never a re-serialised
  body, and compared in constant time (`safeEqual`, which hashes both sides so length
  does not leak through early exit).
* A missing, `sha1=`, unprefixed, non-hex or wrong-length signature is a rejection, not
  a bypass.
* Nothing is parsed, persisted or logged from an unverified body.
* Replay and duplicate deliveries are suppressed by a unique index on
  `WebhookEvent.deliveryId` — a database constraint, not an in-memory cache that a
  restart or a second instance would defeat.
* Payloads are validated with zod; malformed payloads produce 400.
* The endpoint performs no pipeline work: it verifies, records and enqueues, then
  returns 202.
* Body size is capped at GitHub's documented 25 MiB and the endpoint is rate limited.

## Authentication and authorisation

* **Repository access is GitHub App only.** Personal access tokens are not supported
  anywhere in the codebase.
* Installation tokens are minted through `@octokit/auth-app`, cached in memory for less
  than their lifetime, and never persisted or logged.
* **User sign-in is a separate security context.** GitHub OAuth requests only
  `read:user`; the resulting token cannot read repository contents and is discarded
  immediately after the profile lookup.
* The OAuth `state` parameter is random per attempt, stored in a short-lived HttpOnly
  cookie and compared in constant time.
* Session cookies are HttpOnly, `SameSite=Lax`, and `Secure` in production. Only the
  SHA-256 of the session token is stored, so a database dump cannot be replayed as a
  login. Sign-out is POST-only, so a cross-site GET cannot log a user out.

## Capibara never merges

`GitHubProvider` exposes no merge, approve or auto-merge operation, and pull requests
are always opened as drafts. A test asserts the provider's method surface contains
neither `merge` nor `approve`.

`PUBLISH` refuses to run unless the sandbox verification actually passed; a skipped
publish is recorded with the reason.

## Filesystem isolation

* Each job gets its own directory under a single configured `WORKSPACE_ROOT`. The
  directory name is generated (`mkdtemp`), never derived from user input, and created
  with mode `0700`.
* Every path derived from a workspace goes through `resolveWithin`, which normalises
  the input, rejects absolute paths, Windows drive letters, UNC prefixes, NUL bytes and
  `..`, and then proves the resolved path is inside the workspace.
* Disposal is idempotent and refuses to delete anything outside the root. Workspaces are
  disposed on success, on failure and on cancellation (`withWorkspace`'s `finally`).
* Orphans left by crashed processes are reaped by age at worker startup.
* A test asserts one workspace cannot read another's files.

## Process execution

* `spawn` is always called with `shell: false` and an explicit argv array. Repository
  content can never be interpreted by a shell — there is a test that passes
  `"; touch pwned"` as an argument and asserts nothing was executed.
* The executable name is validated strictly; arguments are rejected for NUL bytes,
  control characters and absurd length.
* The child's environment is built from an **allowlist**, not by filtering the parent's.
  A deny-list would leak every credential whose name we failed to predict. A test asserts
  an unrelated `CAPIBARA_TEST_FAKE_SECRET` is not visible to the child.
* `npm_config_ignore_scripts=true` is set, so `npm install` in an untrusted repository
  cannot execute lifecycle scripts.
* Timeouts escalate SIGTERM → SIGKILL against the whole process group.
* Output is bounded (50 KB per stream) so a runaway build cannot exhaust memory.

## Git credentials

`GitRepositoryProvider` writes the installation token to a `0600` credential file
*beside* the checkout and references it through `credential.helper`. The token never
appears in the clone URL, in argv (visible in `/proc`) or in the environment. The file
is deleted in a `finally` block — there is a test asserting it does not survive a failed
clone. `.git` is removed after checkout so nothing downstream can push.

## What is sent to the AI provider

`buildMigrationContext` (`packages/llm/src/context.ts`) is the only way to construct an
AI request. It enforces that:

* exactly one file is referenced, never a repository or a directory;
* the file is a source file and does not match a forbidden path (`.env*`, `.git`,
  `.ssh`, `*.pem`/`*.key`, `secrets.*`, `credentials*`, `.npmrc`, `node_modules`, …);
* only a bounded window (±25 lines) around the call site is included;
* the excerpt is redacted, and the request is **refused** if a credential survives
  redaction;
* the excerpt is truncated to a hard character cap, and the whole prompt is refused if
  it exceeds `FIREWORKS_MAX_PROMPT_CHARS`.

The model returns search/replace edits, not file rewrites. Edits whose `search` text is
not present verbatim in the excerpt are dropped as hallucinations, and every resulting
patch goes through the same validator as a deterministic one.

## SQL

All database access is either Prisma model methods or parameterised statements through
`SqlClient`. No user-controlled value is ever interpolated into SQL; the only
interpolated fragments are compile-time constant column lists.

## Errors

`CapibaraError.toPublicJSON()` returns a stable code, a category and a curated public
message. Stack traces, internal details and causes are never serialised into an HTTP
response.

## HTTP headers

`apps/web/middleware.ts` sets `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` and a
`Content-Security-Policy` on **every** response. The previous matcher excluded `/api`,
which left the API responses unprotected; it no longer does.

## Known gaps

These are real limitations, deliberately not papered over:

* **The sandbox is process-level, not kernel-level.** Commands run as the worker user
  with a minimal environment and no shell, but a determined repository could still read
  files the worker user can read. Running arbitrary untrusted repositories safely needs
  a container or VM boundary per job. A container runner was removed rather than left in
  a broken, injection-prone state.
* **No network isolation for sandboxed commands.** `npm install` needs the registry;
  restricting egress requires the container boundary above.
* **Authorisation is coarse.** Sessions identify a user, but there is no per-repository
  permission check on dashboard routes yet.
* **`ENCRYPTION_KEY` is unused today** because nothing sensitive is stored at rest
  (installation access tokens are fetched from GitHub when needed, never persisted).
  The primitive exists so that future persistence does not invent its own scheme.
* **Rate limiting is per-process**, not distributed.
