
#!/usr/bin/env python3
import os, json
from pathlib import Path

base = Path(".")
errors = []
print("=== Tern Final Verification ===\n")

required_dirs = [
    "apps/web", "apps/worker", "packages/shared", "packages/db", "packages/github",
    "packages/openapi", "packages/scanner", "packages/migration-engine", "packages/sandbox",
    "packages/llm", "docker", "demo", "docs", "tests", "scripts"
]
for d in required_dirs:
    if (base / d).exists():
        print(f"\u2705 {d}")
    else:
        errors.append(f"Missing directory: {d}")

packages = [
    "package.json", "apps/web/package.json", "apps/worker/package.json"
] + [f"packages/{p}/package.json" for p in [
    "shared", "db", "github", "openapi", "scanner", "migration-engine", "sandbox", "llm"
]]
for p in packages:
    try:
        with open(base / p) as f:
            json.load(f)
        print(f"\u2705 {p}")
    except Exception as e:
        errors.append(f"Invalid {p}: {e}")

required_files = [
    "README.md", "docs/architecture.md", "docs/security.md", "docs/environment.md",
    "docs/deployment.md", "docs/migration-engine.md", "docs/scanner.md", "docs/worker.md",
    "docs/github-app-setup.md", "docs/demo-mode.md", "docs/REQUIRED_ENV.md",
    "ARCHITECTURE_SUMMARY.md"
]
for f in required_files:
    if (base / f).exists():
        print(f"\u2705 {f}")
    else:
        errors.append(f"Missing file: {f}")

ts_count = 0
tsx_count = 0
test_count = 0
for root, dirs, files in os.walk(base):
    dirs[:] = [d for d in dirs if d not in ["node_modules", ".git", "dist", ".next"]]
    for f in files:
        if f.endswith(".test.ts") or f.endswith(".test.tsx"):
            test_count += 1
        elif f.endswith(".ts"):
            ts_count += 1
        elif f.endswith(".tsx"):
            tsx_count += 1

print(f"\nTS files: {ts_count}, TSX files: {tsx_count}, Test files: {test_count}")
print(f"Total tracked files: {ts_count + tsx_count + test_count}")

print("\n=== Summary ===")
if not errors:
    print("\u2705 All verification checks passed!")
else:
    print(f"\u274c {len(errors)} errors:")
    for e in errors:
        print(f"  - {e}")

print(f"\nExit code: {1 if errors else 0}")
