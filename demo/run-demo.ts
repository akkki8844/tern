
    import { DefaultSpecLoader, DefaultDiffEngine } from "@tern/openapi";
    import { TreeSitterScanner } from "@tern/scanner";
    import { DefaultMigrationEngine } from "@tern/migration-engine";
    import { buildPullRequestReport, renderPullRequestBody } from "@tern/github";
    import { DefaultSandboxRunner } from "@tern/sandbox";
    import path from "path";

    async function main() {
      const specLoader = new DefaultSpecLoader();
      const oldSpec = await specLoader.load(path.resolve("demo/specs/acmepay-v1.yaml"));
      const newSpec = await specLoader.load(path.resolve("demo/specs/acmepay-v2.yaml"));

      const diffEngine = new DefaultDiffEngine();
      const changes = await diffEngine.diff(oldSpec, newSpec);
      const instructions = diffEngine.getMigrationInstructions();

      const scanner = new TreeSitterScanner();
      const usages = await scanner.scan(path.resolve("demo/broken-app/src"), changes);
      const benchmark = scanner.getBenchmark();

      const migrationEngine = new DefaultMigrationEngine();
      const patches = await migrationEngine.generatePatches(path.resolve("demo/broken-app"), changes, usages, instructions);
      const stats = migrationEngine.getStats();

      const sandbox = new DefaultSandboxRunner();
      const sandboxResult = await sandbox.run(path.resolve("demo/broken-app"), "npm test", { timeoutMs: 60000, cleanup: true });

      const report = buildPullRequestReport(changes, usages, patches, sandboxResult);
      const prBody = renderPullRequestBody(report);

      console.log("
=== Tern AcmePay Demo ===\n");
      console.log(`Detected ${changes.length} API changes`);
      console.log(`Scanned ${benchmark.filesScanned} files (${benchmark.totalLines} lines) in ${benchmark.durationMs}ms`);
      console.log(`Found ${benchmark.callSitesFound} call sites, ${benchmark.matchesFound} matched`);
      console.log(`Generated ${patches.length} valid patches`);
      console.log(`Migration engine stats: ${JSON.stringify(stats)}`);
      console.log(`Sandbox result: ${sandboxResult.status} (${sandboxResult.durationMs}ms)`);
      console.log("\n=== Generated PR Body ===\n");
      console.log(prBody);
    }

    main().catch(err => {
      console.error(err);
      process.exit(1);
    });
