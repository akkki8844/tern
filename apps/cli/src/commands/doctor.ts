
import pc from "picocolors";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import { runProcess } from "@capibara/sandbox";
import { inspectEnvironment } from "@capibara/shared";
import { treeSitterLoadable } from "@capibara/scanner";
import { banner, symbols } from "../ui.js";

interface Check {
  name: string;
  detail: string;
  state: "ok" | "warn" | "fail";
  hint?: string;
}

/** dist/commands/doctor.js → repo root is four levels up. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * `capibara doctor` — verifies this machine can run everything, with a hint
 * for every failure. Never mutates anything; only reads and probes.
 */
export async function runDoctor(version: string): Promise<number> {
  const interactive = process.stdout.isTTY === true;
  if (interactive) clack.intro(banner(version));

  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    detail: process.versions.node,
    state: major >= 20 ? "ok" : "fail",
    hint: major >= 20 ? undefined : "Capibara requires Node.js 20 or newer"
  });

  try {
    // The sandbox runner enforces argv-only execution with a sanitised
    // environment — the only sanctioned way to spawn a process here.
    const result = await runProcess("git", ["--version"], repoRoot(), {
      timeoutMs: 10_000,
      env: {},
      maxOutputBytes: 1024
    });
    checks.push({ name: "git", detail: result.stdout.trim().replace("git version ", "v"), state: "ok" });
  } catch {
    checks.push({
      name: "git",
      detail: "not found",
      state: "fail",
      hint: "The worker checks out repositories with git — install git"
    });
  }

  const tsLoadable = treeSitterLoadable();
  checks.push({
    name: "tree-sitter grammars",
    detail: tsLoadable ? "loaded" : "unavailable",
    state: tsLoadable ? "ok" : "warn",
    hint: tsLoadable
      ? undefined
      : "The AST scanner needs the native tree-sitter module; without it the CLI falls back to literal-path evidence (lower precision)"
  });

  const prismaClient = existsSync(join(repoRoot(), "node_modules", ".prisma", "client", "index.js"));
  checks.push({
    name: "Prisma client",
    detail: prismaClient ? "generated" : "not generated",
    state: prismaClient ? "ok" : "warn",
    hint: prismaClient
      ? undefined
      : "Run `npm run db:generate` (needs network access to binaries.prisma.sh). Only the web/worker stack needs it — not `capibara analyze`"
  });

  const environment = inspectEnvironment();
  if (!environment.databaseUrl.present) {
    checks.push({
      name: "DATABASE_URL",
      detail: "not set",
      state: "warn",
      hint: "Required for the worker and dashboard (PostgreSQL). Not needed for `capibara analyze`, `report` or `demo`"
    });
  } else if (environment.databaseUrl.isPostgres) {
    checks.push({ name: "DATABASE_URL", detail: "postgresql connection string", state: "ok" });
  } else {
    checks.push({
      name: "DATABASE_URL",
      detail: "not a postgresql:// URL",
      state: "fail",
      hint: "Capibara only supports PostgreSQL"
    });
  }

  checks.push({
    name: "Mode",
    detail: environment.mode ?? "production (default)",
    state: "ok"
  });

  const demoSpecs = existsSync(join(repoRoot(), "demo", "specs", "acmepay-v1.yaml"));
  checks.push({
    name: "Demo fixtures",
    detail: demoSpecs ? "present" : "missing",
    state: demoSpecs ? "ok" : "warn",
    hint: demoSpecs ? undefined : "`capibara demo` needs demo/specs/ from the repository"
  });

  const failed = checks.filter((c) => c.state === "fail");
  const warned = checks.filter((c) => c.state === "warn");

  const lines = checks.map((check) => {
    const mark = check.state === "ok" ? symbols.ok() : check.state === "warn" ? symbols.warn() : symbols.fail();
    const line = `${mark} ${check.name.padEnd(20)} ${check.detail}`;
    return check.hint && check.state !== "ok" ? `${line}\n      ${pc.dim(check.hint)}` : line;
  });

  const summary =
    failed.length > 0
      ? symbols.fail(`${failed.length} problem(s), ${warned.length} warning(s)`)
      : warned.length > 0
        ? symbols.warn(`${warned.length} warning(s) — analyze, report and demo work regardless`)
        : symbols.ok("All checks passed.");

  const body = lines.join("\n") + "\n\n" + summary;
  if (interactive) {
    clack.note(body, "Doctor");
    clack.outro(failed.length > 0 ? "Fix the problems above, then re-run `capibara doctor`." : "Ready.");
  } else {
    process.stdout.write(`${body}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}

