
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import { analyzeSpecChange, loadFromString } from "@capibara/openapi";
import { banner, symbols } from "../ui.js";
import { changeRows, footerHint, renderChanges, renderSeveritySummary } from "../renders.js";

export interface ReportOptions {
  old: string;
  new: string;
  json: boolean;
}

/**
 * `capibara report` — the OpenAPI diff alone. Fast, no repository analysis.
 * Same exit semantics as analyze: 0 clean, 1 breaking changes, 2 error.
 */
export async function runReport(options: ReportOptions, version: string): Promise<number> {
  const interactive = process.stdout.isTTY === true && !options.json;
  try {
    if (interactive) clack.intro(banner(version));
    const [oldText, newText] = await Promise.all([
      readFile(resolve(options.old), "utf8"),
      readFile(resolve(options.new), "utf8")
    ]);
    const analysis = analyzeSpecChange(loadFromString(oldText), loadFromString(newText));

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ command: "report", summary: analysis.summary, changes: analysis.changes }, null, 2)}\n`
      );
      return analysis.changes.some((c) => c.severity === "BREAKING") ? 1 : 0;
    }

    const report = [renderSeveritySummary(analysis), renderChanges(changeRows(analysis))].join("\n");
    if (interactive) {
      clack.note(report, "API report");
      clack.outro(footerHint());
    } else {
      process.stdout.write(`${report}\n\n${footerHint()}\n`);
    }
    return analysis.changes.some((c) => c.severity === "BREAKING") ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interactive) clack.log.error(message);
    else process.stderr.write(`${symbols.fail(message)}\n`);
    return 2;
  }
}
