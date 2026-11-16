# Capibara CLI

`capibara` is the primary way to use Capibara. One binary, four commands, no
database required for the analysis workflow.

```
 ╭────────────────────────────────────────────────────────╮
 │  ◆ capibara v0.1.0                                     │
 │  API breaking changes, mapped to the exact code they   │
 │  affect.                                               │
 ╰────────────────────────────────────────────────────────╯
```

## Install / build

```bash
npm install
npm run build          # builds packages + web + cli
npx capibara --help    # workspace bin, or: npm run capibara -- --help
```

## Commands

### `capibara analyze`

The core command. Diffs two OpenAPI documents with the semantic engine, scans a
repository with the AST engine, and reports **exactly which code is affected,
why, and how confident the scanner is**.

```bash
capibara analyze --old api/v1.yaml --new api/v2.yaml ./src
```

| Option | Meaning |
| --- | --- |
| `--old <path>` / `--new <path>` | The two OpenAPI documents (YAML or JSON). |
| `[source]` | Repository directory to scan. Defaults to the current directory. |
| `--verbose` | Show the full evidence chain for every detected usage. |
| `--json` | Machine mode: a single JSON document on stdout, nothing else. |

Exit codes (CI-friendly, deterministic):

- `0` — no breaking changes.
- `1` — breaking changes found (the report still prints in full).
- `2` — error (unreadable spec, bad path, scanner failure).

The analysis never modifies files, never executes repository code and never
sends anything anywhere.

### `capibara report`

The OpenAPI diff alone — severity-classified change list with rule identity and
precise locations. Fast; no repository analysis.

```bash
capibara report --old api/v1.yaml --new api/v2.yaml
```

### `capibara demo`

Runs the complete eight-stage pipeline (discover → diff → scan → plan →
migrate → validate → test → publish) against the bundled AcmePay example. Real
diffing, real scanning, real deterministic migration, real sandboxed
install/build/test — with in-memory GitHub/AI providers, so it touches **no
network and no database**.

```bash
capibara demo
```

### `capibara doctor`

Readiness probe: Node version, git, tree-sitter grammars, Prisma client,
`DATABASE_URL` shape, demo fixtures. Every non-passing check prints an
actionable hint. Exits `1` only when something is actually broken.

```bash
capibara doctor
```

## Output conventions

- Colours follow `NO_COLOR` and degrade to plain text on non-TTY output, so
  `capibara analyze … | jq` and CI logs stay clean.
- `--json` suppresses every decorative byte: stdout carries exactly one JSON
  document (`summary`, `changes`, and `scan` where applicable).
- All renderers are deterministic: the same inputs produce byte-identical text.

## The stack in one line

```
capibara analyze  =  semantic diff (packages/openapi)
                   + repository scan (packages/scanner, tree-sitter AST,
                     symbol resolution, wrapper chains, evidence + confidence)
```

The web dashboard and worker (PostgreSQL-backed, GitHub App driven) run the
same engines for the automated, repository-installation workflow — see
`docs/deployment.md`. The CLI is the direct, local path.
