
# Public API

## Packages

### `@tern/openapi`

- `DefaultSpecLoader` — load and parse OpenAPI 3.x specs.
- `DefaultDiffEngine` — diff specs and generate migration instructions.
- `normalizeOperations(spec)` — flatten operations into a normalized form.
- `normalizeSchema(schema)` — flatten a schema into a normalized form.

### `@tern/scanner`

- `TreeSitterScanner` — scan a repository for affected call sites.
- `scanner.scan(repoPath, changes, options)` — return `AffectedUsage[]`.
- `scanner.getBenchmark()` — return scan metrics.

### `@tern/migration-engine`

- `DefaultMigrationEngine` — generate migration patches.
- `DefaultPatchValidator` — validate a patch.

### `@tern/sandbox`

- `DefaultSandboxRunner` — run tests in an ephemeral sandbox.
- `DockerSandboxRunner` — Docker-based isolated runner.

### `@tern/github`

- `GitHubService` interface and `OctokitGitHubService` / `MockGitHubService` implementations.
- `buildPullRequestReport` and `renderPullRequestBody`.

### `@tern/llm`

- `LlmAdapter` interface.
- `FireworksAdapter` and `MockLlmAdapter`.

### `@tern/shared`

- `getConfig`, `getLogger`, `container`, `withRetry`, `redactSecrets`, `sanitizePath`, `isExecutableContent`.
