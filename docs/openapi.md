# OpenAPI intelligence

`packages/openapi` turns two OpenAPI documents into a typed, deterministic description
of what changed and who it breaks. It is the first half of Tern's pipeline; the
repository scanner consumes its output.

Everything here is deterministic and offline. No LLM is involved in deciding whether a
change is breaking, and no network request is made while analysing a document.

## Contents

- [Supported versions](#supported-versions)
- [Pipeline](#pipeline)
- [Canonical model](#canonical-model)
- [Normalisation](#normalisation)
- [Semantic diff](#semantic-diff)
- [Request vs response compatibility](#request-vs-response-compatibility)
- [Severity and confidence](#severity-and-confidence)
- [Rename hypotheses](#rename-hypotheses)
- [References](#references)
- [Security model](#security-model)
- [Resource limits](#resource-limits)
- [Limitations](#limitations)
- [Usage](#usage)

The full rule table lives in [`openapi-rules.md`](openapi-rules.md), which is generated
from the code.

## Supported versions

| Version | Status |
| --- | --- |
| OpenAPI 3.0.x | Supported and tested |
| OpenAPI 3.1.x | Supported and tested for the constructs listed below |
| Swagger 2.0 and earlier | Rejected with `OPENAPI_VERSION_UNSUPPORTED` |

3.1 support covers type arrays (`type: ["string", "null"]`), numeric
`exclusiveMinimum`/`exclusiveMaximum`, `const`, `$ref` with sibling keywords (treated as
the implicit `allOf` the specification defines), and documents that declare `webhooks`
without `paths`. 3.1 keywords Tern does *not* analyse — `prefixItems`, `contains`,
`dependentSchemas`, `if`/`then`/`else`, `unevaluatedProperties`, `patternProperties` —
are detected and reported as unsupported rather than ignored.

A 3.0 document and its faithful 3.1 translation produce **no** changes. There is a test
for this: migrating your specification's version must not look like a wall of breaking
changes.

## Pipeline

```
document ──parse──▶ raw JSON ──build──▶ canonical model ──diff──▶ SpecChangeAnalysis
   │                   │                     │                          │
 size caps        key stripping        refs resolved,            typed changes with
 version check    node budget          cycles handled            direction, severity,
                                                                 confidence, location
```

## Canonical model

`buildApiModel(document)` produces an `ApiModel`:

| Element | Notes |
| --- | --- |
| `operations` | Sorted by `${METHOD} ${path}`; path-level and operation-level parameters merged |
| `parameters` | Sorted by (`in`, `name`); path parameters are always required |
| `requestBody` / `responses` | **Every** media type is kept, not just the first |
| `registry` | All schemas, keyed by canonical JSON pointer |
| `componentSchemas` | Name → schema id |
| `unsupported` | Constructs that could not be analysed |

### Schemas are a registry, not a tree

`$ref` targets are never inlined. Every schema — component or inline — is registered
under its JSON pointer and referenced by that id. This buys three properties at once:

1. **Termination.** `Node → Node` and `A → B → A` are ordinary finite graphs.
2. **Provenance.** The id *is* the origin: ten operations referencing `User` all point
   at `#/components/schemas/User`, so "what does this schema mean" and "where did it
   come from" are both answerable.
3. **Determinism.** Ids are derived from document structure, never generated.

## Normalisation

Normalisation removes differences that carry no meaning and preserves everything a
migration needs.

**Normalised away**

| Input | Canonical form |
| --- | --- |
| Object key order | Irrelevant; maps are built in sorted order |
| HTTP method casing | Lower-case in the model, upper-case in operation keys |
| Enum value order | Sorted by canonical JSON encoding |
| `required` array order | A set |
| Response status order | Numeric, `default` last |
| `nullable: true` (3.0) vs `type: [..., "null"]` (3.1) | `nullable: true` plus the non-null types |
| `minimum: 5, exclusiveMinimum: true` (3.0) vs `exclusiveMinimum: 5` (3.1) | A numeric exclusive bound |
| `additionalProperties` absent vs `true` | Both mean "open" |
| `$ref` to a schema vs an identical inline schema | Compared structurally, so neither is a change |
| An extra hop in a `$ref` chain | Chains are followed to their target |
| YAML vs JSON | Same model |
| `description`, `summary`, `example` | Not compatibility-relevant |

**Never normalised away**

`operationId`, parameter names and locations, schema names, property names, enum
*values*, required status, response status codes, media types, formats, and reference
provenance.

Normalisation is deterministic: `normalize(A)` is byte-identical across runs, and
`diff(A, A)` is empty.

## Semantic diff

`analyzeSpecChange(oldDocument, newDocument)` returns a `SpecChangeAnalysis`:

```ts
{
  changes: ApiChange[];            // sorted by location then rule
  renameCandidates: RenameCandidate[];
  unsupported: UnsupportedNote[];
  componentUsage: ComponentUsage[];
  summary: { total, breaking, conditional, nonBreaking, unknown, byDirection };
}
```

Each `ApiChange` carries:

| Field | Purpose |
| --- | --- |
| `id` | SHA-256 of rule + location + direction + values, truncated. Stable across runs and machines. |
| `rule` | The catalog entry that made the decision |
| `kind` | `path` \| `operation` \| `parameter` \| `requestBody` \| `response` \| `schema` \| `component` \| `document` |
| `location` | `displayPath` plus structured `path`, `method`, `operationId`, `parameterName`, `parameterIn`, `statusCode`, `mediaType`, `componentSchema`, `propertyPath`, `propertyName` |
| `direction` | `request` \| `response` \| `both` \| `unknown` |
| `severity` | `BREAKING` \| `CONDITIONAL` \| `NON_BREAKING` \| `UNKNOWN` |
| `breaking` | `severity === "BREAKING"` |
| `confidence` | `HIGH` \| `MEDIUM` \| `LOW` \| `UNKNOWN` |
| `reason` | One sentence in terms of an existing client |
| `oldValue` / `newValue` | The concrete values that changed |

Example rendering:

```
BREAKING
  Parameter id became required in GET /users/{id}
    at        paths./users/{id}.get.parameters.path.id.required
    change    false -> true
    direction request
    rule      PARAMETER_MADE_REQUIRED
    reason    Callers that legitimately omitted this parameter now send invalid requests.
    confidence HIGH
```

### Shared schemas are not collapsed

When `User` is a response of `GET /users` and a request of `POST /users`, a change to
`User` is reported **twice** — once per usage, with the correct direction and severity
for that usage. `componentUsage` additionally answers "the `User` schema changed, which
operations does that touch?".

## Request vs response compatibility

This is the single most important idea in the engine:

> **Narrowing** what a server accepts breaks **requests**.
> **Widening** what a server returns breaks **responses**.

Consequences, all of which are tested in both directions:

| Change | Request | Response |
| --- | --- | --- |
| Property made required | **breaking** | safe |
| Property made optional | safe | **breaking** |
| Value may now be null | safe | **breaking** |
| Value may no longer be null | **breaking** | safe |
| Type narrowed (`number` → `integer`) | **breaking** | safe |
| Type widened (`integer` → `number`) | safe | **breaking** |
| Enum value removed | **breaking** | conditional |
| Enum value added | safe | conditional |
| `additionalProperties: false` introduced | **breaking** | safe |
| `minimum` raised | **breaking** | safe |
| Property removed | conditional | **breaking** |

Asymmetry is deliberate and never assumed. Each direction has its own test.

## Severity and confidence

`CONDITIONAL` is a first-class verdict, not a hedge. A large class of changes breaks
*some* clients: removing a request property is harmless for a caller that never sent it;
adding a response enum value only breaks exhaustive handling. Forcing those into a
boolean produces either a stream of false positives or silent false negatives. Marking
them `CONDITIONAL` states the truth — *this depends on how the repository uses the API*
— which is exactly the question the scanner answers next.

Confidence describes **evidence**, not probability. There are no synthetic percentages.

| Value | Meaning |
| --- | --- |
| `HIGH` | An unambiguous local rule over fully analysed data |
| `MEDIUM` | The rule is sound; the effect depends on client behaviour Tern cannot observe |
| `LOW` | Detected structurally; the semantic effect depends on partially-modelled composition |
| `UNKNOWN` | An unsupported construct is involved; no claim is made |

## Rename hypotheses

Renames are reported separately from classifications, in `renameCandidates`. They are
**never** used to decide whether something is breaking: the authoritative answer for a
rename is always `PROPERTY_REMOVED` plus `PROPERTY_ADDED`.

A hypothesis is only raised from structural evidence, never from name similarity:

| Hypothesis | Evidence required | Confidence |
| --- | --- | --- |
| Property renamed | Both properties reference the same component schema | `MEDIUM` |
| Property renamed | Exactly one removed and one added in the same object, and the two schemas are structurally identical | `LOW` |
| Parameter renamed | Exactly one removed and one added on the operation, same `in` | `LOW` |
| operationId renamed | Same path and method, different id | `HIGH` |
| operationId renamed | Exactly one id vanished and one appeared, same HTTP method | `LOW` |
| Path renamed | Exactly one path removed and one added, identical method sets | `LOW` |

`emailAddress` → `emailVerified` produces no hypothesis. `source` → `payment_method`
does, when the shapes match. That is the right way round.

## References

| Reference | Behaviour |
| --- | --- |
| `#/components/schemas/X` | Resolved |
| `#/components/parameters/X`, `responses`, `requestBodies` | Resolved |
| Chains `A → B → C` | Followed to the target, up to `maxRefChain` hops |
| `A → B → A` with no content | Rejected: `OPENAPI_REF_CYCLE` |
| Recursive schemas (`Node → Node`) | Fully supported; comparison terminates |
| Unresolvable internal ref | Rejected: `OPENAPI_REF_UNRESOLVED` |
| `other.yaml#/...`, `https://…`, `file://…` | **Never fetched.** Modelled as opaque and reported as unsupported |

Recursive comparison terminates by memoising *pairs* of schema ids: re-entering a pair
already under comparison returns "no findings", the standard coinductive treatment of
equirecursive types. The number of distinct pairs is bounded by |old| × |new|.

## Security model

OpenAPI documents are untrusted input.

| Risk | Mitigation |
| --- | --- |
| SSRF via external `$ref` | External references are never resolved. There is no code path that fetches one. |
| SSRF via remote spec loading | Off by default. Enabling it requires an explicit host allowlist, HTTPS, no redirects, and a timeout. |
| SSRF to internal ranges | Loopback, link-local, `10/8`, `172.16/12`, `192.168/16`, `::1` and `.internal`/`.local` are refused **before** the allowlist is consulted, so an operator cannot allowlist their way to the metadata endpoint. |
| Path traversal | Local paths resolve inside a configured `rootDir` and are proven to stay there. Without a root, only absolute operator-supplied paths are accepted. |
| Prototype pollution | `__proto__`, `constructor` and `prototype` keys are stripped during parsing; pointer resolution uses own-property access only. |
| Malicious YAML | `CORE_SCHEMA` with `json: true`: no custom tags, no constructors. |
| YAML alias bombs | A node budget is enforced while rebuilding the parsed document. |
| Uncontrolled recursion | Depth limits, node budgets and pair memoisation. |
| Denial of service | Every traversal is bounded; exceeding a bound raises a typed `OpenAPIError`. |
| Unsafe evaluation | None. No `eval`, no `Function`, no dynamic `require`. |

## Resource limits

Defaults (`DEFAULT_LIMITS`, all overridable per call):

| Limit | Default |
| --- | --- |
| `maxDocumentBytes` | 10 MiB |
| `maxModelNodes` | 200 000 |
| `maxSchemaDepth` | 100 |
| `maxOperations` | 10 000 |
| `maxComponentSchemas` | 20 000 |
| `maxEnumValues` | 10 000 |
| `maxComparisons` | 500 000 |
| `maxChanges` | 50 000 |
| `maxRefChain` | 32 |

Measured on this machine: a 1 000-path document diffs in well under a second, and 200
operations sharing one changed schema produce 200 correctly-located findings without
quadratic blow-up, because schema comparisons are memoised per (old id, new id,
direction) and re-located at each usage.

## Limitations

Stated plainly, because pretending otherwise is worse than the gap:

- **Regular languages are not compared.** A changed `pattern` is reported as
  `CONDITIONAL` with `LOW` confidence; Tern does not decide regex containment.
- **`oneOf`/`anyOf` members are matched by reference identity, then position.** Two
  structurally identical inline variants in a different order look like a change.
- **`allOf` is merged only when every member is a plain object contribution.** When a
  member uses `oneOf`, `anyOf`, `enum` or an unsupported keyword, the merge is abandoned
  and the change is reported as `ALL_OF_MEMBER_ADDED`/`REMOVED` with `LOW` confidence.
- **`not`, `discriminator`, `if`/`then`/`else`, `patternProperties`, `prefixItems`,
  `contains`, `dependentSchemas` and `unevaluatedProperties` are not analysed.** A change
  to one is reported as `UNSUPPORTED_CONSTRUCT_CHANGED` with `UNKNOWN` severity.
- **Header and cookie *response* headers are compared by name only**, not by schema.
- **Webhooks are parsed but not diffed.**
- **Server variables are not expanded**; only the literal `url` strings are compared.
- **Cross-document `$ref` is out of scope** and always will be unless a safe fetching
  story exists.

## Usage

```ts
import { analyzeSpecChange, formatChangeReport, loadFromString } from "@tern/openapi";

const before = loadFromString(await readFile("openapi.v1.yaml", "utf8"));
const after = loadFromString(await readFile("openapi.v2.yaml", "utf8"));

const analysis = analyzeSpecChange(before, after);

console.log(formatChangeReport(analysis));
console.log(analysis.summary);          // { breaking: 2, conditional: 4, … }
console.log(analysis.componentUsage);   // which operations a changed schema touches
```

Loading a local file safely:

```ts
const loader = new DefaultSpecLoader({ rootDir: "/srv/specs" });
const document = await loader.load("api/openapi.yaml");   // confined to rootDir
```

The legacy `DefaultDiffEngine` surface still exists and is implemented on top of
`analyzeSpecChange`; it projects the analysis down to `BreakingChange[]` plus
`MigrationInstruction[]` for the pipeline and migration engine, dropping
`NON_BREAKING` changes so the scanner is not sent looking for usages that cannot need
migrating.
