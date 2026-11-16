# Repository Scanner

The scanner answers one question: **given these OpenAPI changes, exactly where in
this TypeScript/JavaScript repository could they affect existing code?** It
analyses and reports. It never modifies files, never generates patches and never
calls an LLM.

Two engines exist:

- **AST engine** (`RepositoryScanner`) — the primary engine. Tree-sitter parse →
  module graph → symbol resolution → usage adapters → operation matching →
  response flow → wrapper chains. Everything below describes it.
- **Literal fallback** (`SimpleRegexScanner`) — only used when the native
  tree-sitter module cannot load. It reports string-literal path evidence at
  LOW confidence and is explicitly weaker; the pipeline logs a warning when it
  degrades.

## Architecture

```
OpenAPI diff engine (SpecChangeAnalysis)
        │
        ▼
 discovery ─► parse/analyse ─► tsconfig paths ─► module resolver ─► symbol resolver
        │                                                                      │
        ▼                                                                      ▼
 operation index (METHOD path, previous operationIds) ─► usage adapters ─► matching
        │                                                                      │
        ▼                                                                      ▼
 response flow analysis ─► conditional refinement (Step 16) ─► affected usage graph
```

Every stage is a pure function of its inputs. There is no clock, no randomness
and no unordered iteration anywhere in the pipeline: the same repository plus
the same diff analysis produces byte-identical output (wall-clock `timing`
aside, which measures, and does not describe).

## Discovery

- Extensions scanned: `.ts .tsx .js .jsx .mts .cts .mjs .cjs` (+ `.d.ts`).
- Always skipped: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`,
  `.turbo`, `.cache`, `vendor`; `.gitignore` is honoured.
- Explicit `include`/`exclude` glob patterns can widen or narrow the set.
- Guards: per-file size limit (2 MiB), file-count limit (20 000), binary
  sniffing, generated-file markers, duplicate-content hashing, symlink-loop and
  **symlink-escape** detection (a symlink is followed only when its real path
  stays inside the scan root — never outside the workspace).
- Every exclusion is recorded in `metrics.discovery.exclusions` with a reason.

## Parsing

Tree-sitter grammars: `typescript` for `.ts/.mts/.cts/.d.ts`, `tsx` for
`.tsx/.jsx/.js/.mjs/.cjs`. Parsing is error-recovering: a file with a syntax
error yields a partial analysis, is listed in `parseFailures`, and **never
blocks other files**. Node and depth guards (max nodes/file, walk depth 400)
protect against pathological inputs.

Modelled constructs: imports (default/named/namespace/side-effect/type-only),
exports (including `export *`, re-export chains, `export const`), functions,
arrow functions, classes and methods, variables, interfaces, type aliases,
enums, namespaces, object literals, destructuring, optional chaining, template
literals (with static/hole segments), async/await, decorators (as opaque
syntax).

## Module graph and symbol resolution

- Relative imports with extension probing (`.ts` first, then TS/JS siblings,
  `.d.ts`, `/index.*`), `tsconfig.json` `paths`/`baseUrl` (parsed statically —
  configs are never executed), bare specifiers → **external** (never probed in
  `node_modules`), unresolved → explicit `UNRESOLVED`, counted in metrics.
- Symbol resolution walks scope chains innermost-first, so a parameter named
  `client` shadows an imported `client` — and shadowing is only *reported*
  when the name is also declared further out.
- Import chains cross files (with `via: import|reexport` provenance); crossing
  a re-export upgrades `via` accordingly. Export-star conflicts stay ambiguous.

## Usage detection (adapters)

Each adapter inspects a call and reports method/path/body/response identity
with evidence. All roots resolve through the symbol resolver — **no usage is
ever flagged from string matching alone**.

| Adapter | Pattern | Notes |
| --- | --- | --- |
| fetch | `fetch(url, config)` | global `fetch` or `x.fetch`; default GET; `body` via config |
| axios | `axios.get(url, …)`, `api.get(url)` | external import or `axios.create` instance (same file or imported); instance `baseURL` evidence HIGH |
| generated client | bare imported call `createCharge(x)` | identity via operationId (current **or previous**, with the rename stated); path evidence when the SDK leaks paths |
| sdk-resource | `client.charges.retrieve(id)` | resource segments must agree with the path template |
| generic http | `request("GET", path)` single method-named callee | weakest adapter; never invents a method |
| wrapper caller | caller of an exported function that performs an affected call | one hop ⇒ one confidence level down, chain depth ≤ 4 |

Literal-first guards: a local variable is accepted as an HTTP client only when
its initialiser is an object literal or a `new`/`axios.create` call — so
`r.url.includes("/charges")` in a test assertion is **not** an API usage.

## Matching usages to operations

- Operation index keys are `METHOD path` (built from the semantic diff; renames
  keep the *previous* operationId for generated-client matching).
- Path templates are segmented and aligned: `/users`, `/users/{id}` and
  `/users/${id}` are distinct; query strings are stripped and recorded;
  `/users/list` honestly matches both the literal route and the `{id}` route
  (both are reported as LOW candidates — the scanner never picks one).
- `base-absorbed` matching handles axios-style base URLs: the discarded usage
  prefix must be all literals **and** the remainder must agree exactly —
  `/v1/charges` matches `/charges`, but `/hooks/${id}` does not match `/pay`.
- A hole satisfies a path parameter or a literal with an explicit downgrade,
  never a silent acceptance.

## Request / response analysis (conditional refinement)

- Request bodies are walked as nested property paths. A property removal only
  affects call sites that actually send it; others are *refined out*
  (`metrics.matching.refinedOut`). A spread (`{ ...extra }`) is reported as
  `dynamic-object-spread` with UNKNOWN/LOW confidence — never guessed.
- Response flows are tracked through `const res = await client.get(…)`,
  `.json()` chains, destructuring aliases and member access (`res.data.user.email`).
  `.then(…)` callbacks and other complex flows are counted as untracked; a
  response property removal for such a call site is *not* claimed.
- Type-level usage (schema component referenced via generated types) is
  reported as `typed-property-access` when statically reconstructable.

## Confidence

`HIGH | MEDIUM | LOW | UNKNOWN` — no numeric probabilities. Usage confidence is
the **worst** evidence in its chain:

- **HIGH**: method + path (and body/response facts) statically reconstructed —
  e.g. literal path equal to the operation.
- **MEDIUM**: structure known but parts unresolved — template holes, base-path
  absorption, method taken from the matched operation rather than the call site.
- **LOW**: indirect (wrapper chain hop) or genuinely ambiguous candidate sets.
- **UNKNOWN**: construct cannot be resolved (spread bodies, untracked flows) —
  the uncertainty is explicit, never papered over.

Every usage carries: stable id (sha256-16 of coordinates + identity), file,
1-based line/column, kind, operation, evidence list (`kind`, `detail`,
`confidence`), explanation ("what changed, why it affects this line"), change
ids, and — for wrapper chains — the hop chain (`viaChain`).

## Affected usage graph

`graph`: `changes[] → changeToOperations[] → operations[] → operationToUsages[]
→ usageAncestry[]` — answers what changed, where it is used, why it matters,
which change caused it and how confident we are, in one queryable structure.

## Metrics

Structured in `RepositoryScan.metrics` (no dashboards): discovery counts and
exclusion reasons, parse outcomes, import resolution totals, symbol-resolution
totals (including shadowed bindings), usage counts by confidence and kind,
matching (operations indexed/matched, refined-out, ambiguous), response-flow
tracking, and per-phase wall-clock `timing`.

## Determinism

No `Math.random`, no `randomUUID`, no `Date.now` in results; every collection
is sorted before output; ids are content hashes. Byte-equivalence across reruns
is enforced by the golden-suite determinism tests (`tests/integration/golden-repos.test.ts`).

## Security model

- The scanner **never executes repository-controlled code**: no `child_process`,
  no `eval`/`Function`, no dynamic imports of repo files, no execution of
  tsconfig or package.json.
- It reads only files under the scan root (discovery realpath-confines
  symlinks; the read path re-checks `isWithin` as defence in depth).
- It never installs dependencies, runs tests or builds as part of scanning.
- Nothing is sent to any LLM or network service; there are no outbound calls.
- JSON parsing of tsconfig is comment-stripped `JSON.parse` — no JS evaluation.
- Resource limits (files, bytes, nodes, depths, usages, resolution budget)
  bound CPU and memory on hostile inputs; exceeding one is reported, not fatal.

## Performance

Measured with `node tests/perf/scanner-benchmark.mjs` (3 iterations, median;
sandbox CPU — treat as relative, not absolute):

| Fixture | Files | Usages | Median |
| --- | --- | --- | --- |
| flat services | 100 | 200 | ~0.2 s |
| flat services | 1000 | 2000 | ~3.6 s |
| deep import chain | 50 | 1 (chain depth cap) | ~40 ms |
| shared single client | 501 | 500 | ~0.5 s |
| one large generated file | 1 | 2500 | ~4.8 s |

Scaling 100→1000 files ≈ 18× (near-linear). The large-file case dominates per
usage; the wrapper-chain cap (4) and resolution budgets keep deep graphs cheap.

## Limitations — what is NOT guaranteed

- Dynamic paths (`ROUTES[kind]`, env-composed URLs) match only through their
  literal segments; fully dynamic paths produce honest LOW/UNKNOWN findings or
  none.
- Calls through unresolvable imports or external packages are never analysed
  deeper than "external"; no `node_modules` is ever read.
- `.then()` response handling and reassignment-heavy flows are not tracked.
- Reflection, computed member access (`client[method]()`) and dynamic
  `import()` are outside the model; their call sites are simply not claimed.
- Wrapper chains cap at depth 4; deeper chains are counted as truncated.
- Decorator metadata, parameter decorators and DI containers are not modelled.
- The scanner reports *potential* impact. It does not prove a change breaks a
  call site — confidence levels communicate the difference.

## Fallback

`TreeSitterScanner.isAvailable()` reports whether the native grammar loaded.
Without it the pipeline degrades to the literal scanner with a logged warning
(reduced recall; string-literal evidence only) — it never silently returns zero
results.
