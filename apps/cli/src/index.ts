#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { runAnalyze } from "./commands/analyze.js";
import { runReport } from "./commands/report.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("capibara")
  .description("API breaking changes, mapped to the exact code they affect.")
  .version(version, "-V, --version", "print the version");

program
  .command("analyze")
  .description("diff two OpenAPI documents and find the exact code they affect")
  .requiredOption("--old <path>", "previous OpenAPI document (yaml or json)")
  .requiredOption("--new <path>", "next OpenAPI document (yaml or json)")
  .argument("[source]", "repository directory to scan (default: current directory)")
  .option("--verbose", "show the full evidence chain for every usage", false)
  .option("--json", "machine-readable output (single JSON document on stdout)", false)
  .addHelpText(
    "after",
    `
Examples:
  $ capibara analyze --old api/v1.yaml --new api/v2.yaml ./src
  $ capibara analyze --old openapi.old.json --new openapi.json . --verbose --json > report.json

Exit codes:
  0  no breaking changes        1  breaking changes found        2  error
`
  )
  .action(async (source: string | undefined, options: { old: string; new: string; verbose: boolean; json: boolean }) => {
    process.exitCode = await runAnalyze(source, options, version);
  });

program
  .command("report")
  .description("OpenAPI diff report only (fast, no code analysis)")
  .requiredOption("--old <path>", "previous OpenAPI document (yaml or json)")
  .requiredOption("--new <path>", "next OpenAPI document (yaml or json)")
  .option("--json", "machine-readable output", false)
  .action(async (options: { old: string; new: string; json: boolean }) => {
    process.exitCode = await runReport(options, version);
  });

program
  .command("demo")
  .description("run the full eight-stage pipeline on the bundled example (no network, no database)")
  .action(async () => {
    process.exitCode = await runDemo(version);
  });

program
  .command("doctor")
  .description("check this machine is ready to run Capibara")
  .action(async () => {
    process.exitCode = await runDoctor(version);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`capibara: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
