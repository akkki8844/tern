# Scanner

The scanner parses TypeScript and JavaScript repositories to find code affected by OpenAPI breaking changes.

## How It Works

1. **File Collection**: Walks the repository, respecting include/exclude patterns and file size limits (2MB max).
2. **Tree-sitter Parsing**: Parses each file into an AST using Tree-sitter. Gracefully falls back to returning no usages if the native module is unavailable (e.g., unsupported Node.js version).
3. **Import Resolution**: Extracts import bindings to map local identifiers to their module origins.
4. **Call Site Extraction**: Identifies function calls, method invocations, and SDK usage patterns.
5. **Matching**: Scores call sites against breaking changes using a weighted system that considers:
   - Operation ID matches
   - HTTP method + path pattern matches
   - Import path matches
   - Function name similarity
   - Contextual clues (destructured fields, optional chains, async wrappers)

## Confidence Levels

- **High**: Strong signal — matching operation ID, method+path, or import path.
- **Medium**: Partial signal — matching function name or contextual clues.
- **Low**: Weak signal — pattern match with limited context.

## Benchmark Tracking

The scanner tracks metrics for each run:
- Files scanned
- Total lines parsed
- Call sites found
- Matches found
- Duration in milliseconds

## Tree-sitter Fallback

On platforms where the Tree-sitter native module cannot be loaded (e.g., Node.js v24 on Windows without prebuilt binaries), the scanner initializes without a parser and returns empty results. This allows the rest of the pipeline to continue — the migration engine will use LLM fallback for patches.
