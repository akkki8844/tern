
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import { analyzeSpecChange, loadFromString } from "@capibara/openapi";
import { RepositoryScanner, treeSitterLoadable } from "@capibara/scanner";
import { banner, symbols } from "../ui.js";
import { footerHint, renderChanges, renderSeveritySummary, renderUsageReport } from "../renders.js";

export interface AnalyzeOptions {
  old: string;
  new: string;
  json: boolean;
  verbose: boolean;
}

/** Exit codes: 0 = clean, 1 = breaking changes found, 2 = runtime error. */
export async function runAnalyze(
  sourceDir: string | undefined,
  options: AnalyzeOptions,
  version: string
): Promise<number> {
  const interactive = process.stdout.isTTY === true && !options.json;
  const source = resolve(sourceDir ?? process.cwd());

  try {
    const spinner = interactive ? clack.spinner() : null;

    if (interactive) clack.intro(banner(version));

    spinner?.start("Loading OpenAPI documents");
    const [oldText, newText] = await Promise.all([
      readFile(resolve(options.old), "utf8"),
      readFile(resolve(options.new), "utf8")
    ]);
    const oldSpec = loadFromString(oldText);
    const newSpec = loadFromString(newText);
    spinner?.stop(`Loaded ${oldSpec.info?.title ?? "spec"} v${oldSpec.info?.version ?? "?"} → v${newSpec.info?.version ?? "?"}`);

    spinner?.start("Diffing APIs");
    const analysis = analyzeSpecChange(oldSpec, newSpec);
    const breaking = analysis.changes.filter((c) => c.severity === "BREAKING").length;
    spinner?.stop(
      analysis.changes.length === 0
        ? "No API changes detected"
        : `${analysis.changes.length} change(s), ${breaking} breaking`
    );

    // The scan runs in BOTH modes: machine-readable output must carry the
    // affected usages, not just the diff — that is the whole point of analyze.
    spinner?.start(
      `Scanning ${source === process.cwd() ? "current directory" : source} for affected code` +
        (treeSitterLoadable() ? "" : " (tree-sitter unavailable — reduced precision)")
    );
    const scanner = new RepositoryScanner();
    const scan = await scanner.scan(source, analysis);
    spinner?.stop(`${scan.usages.length} affected usage(s) across ${new Set(scan.usages.map((u) => u.file)).size} file(s)`);

    if (options.json) {
      // Machine mode: exactly one JSON document on stdout, nothing else.
      process.stdout.write(
        `${JSON.stringify(
          {
            command: "analyze",
            specs: { old: resolve(options.old), new: resolve(options.new) },
            source,
            summary: analysis.summary,
            changes: analysis.changes,
            scan
          },
          null,
          2
        )}\n`
      );
      return analysis.changes.some((c) => c.severity === "BREAKING") ? 1 : 0;
    }

    if (analysis.changes.length === 0) {
      if (interactive) clack.outro(symbols.ok("Nothing broke. Ship it."));
      else process.stdout.write(`${symbols.ok("No API changes detected.")}\n`);
      return 0;
    }

    const report = [
      renderSeveritySummary(analysis),
      renderChanges(analysis.changes.map((c) => ({ id: c.id, rule: String(c.rule), severity: c.severity, description: c.reason ?? "", location: c.location?.displayPath ?? c.location?.path ?? "" }))),
      renderUsageReport(scan, options.verbose)
    ].join("\n");

    if (interactive) {
      clack.note(report, "Result");
      clack.outro(footerHint());
    } else {
      process.stdout.write(`${report}\n\n${footerHint()}\n`);
    }

    return breaking > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ command: "analyze", error: { message } }, null, 2)}\n`);
    } else if (interactive) {
      clack.log.error(message);
    } else {
      process.stderr.write(`${symbols.fail(message)}\n`);
    }
    return 2;
  }
}
