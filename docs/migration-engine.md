# Migration engine

`packages/migration-engine` turns breaking changes plus affected usages into validated
patches.

## Order of operations

1. **Deterministic rules first.** `rules.ts` holds a table keyed by breaking-change
   type (field renames, parameter renames, endpoint changes, enum changes, …). If a rule
   produces a change, the AI is never consulted.
2. **AI fallback second, and only sometimes.** It runs only when no deterministic rule
   applied *and* the usage confidence is `high` or `medium`. Low-confidence usages are
   never auto-rewritten.
3. **Validation always.** Every patch — deterministic or AI-assisted — goes through
   `DefaultPatchValidator` before it can be returned.

## What the AI is allowed to do

The provider receives a bounded, redacted excerpt of **one** file (see
[`security.md`](security.md)) and returns search/replace edits. It cannot rewrite a
file: an earlier design asked the model for the whole file back, which made the output
impossible to bound or review. Edits whose `search` text is not present verbatim in the
excerpt are dropped as hallucinations.

If no provider is configured, `DisabledAIProvider` is installed and the fallback is
skipped entirely — the engine stays deterministic instead of pretending the model had
nothing to suggest.

## Validation

`DefaultPatchValidator` rejects a patch that:

* targets a forbidden path (`.env`, lockfiles, `package.json`, `.git`, key material, …);
* introduces `eval`, `child_process`, `vm` or similar executable-content patterns;
* contains something that looks like a credential;
* fails a structural sanity check on the diff.

Regression cases live in `tests/integration/security-regression.test.ts`.

## Reentrancy

`generatePatches` keeps its per-call state (migration instructions) local, so one engine
instance can safely serve many analysis runs. Only the aggregate statistics counters are
instance-level.
