# Golden repositories

Each directory is a tiny repository with:

- `src/` — TypeScript sources exercising one usage pattern.
- `openapi-old.json` / `openapi-new.json` — the OpenAPI pair the scanner is given.
- `expected.json` — the usages the scanner must produce: exact
  `file`, `line`, `kind`, `operation` and `confidence` for every usage.

The harness (`../golden.test.ts`) runs the full pipeline — `analyzeSpecChange`
followed by the AST repository scan — and diffs the result against
`expected.json`. Any change in scanner behaviour that moves a usage, changes a
kind or shifts confidence fails here.

Expected files are hand-reviewed: they encode what the scanner MUST report,
including honest LOW confidence where evidence is genuinely weak.
