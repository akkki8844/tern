// `prisma generate` downloads query engines from binaries.prisma.sh. In
// air-gapped or egress-restricted environments that download fails, and a
// failing postinstall would block the entire `npm ci` — including builds and
// tests that never touch the database. This script degrades that failure to a
// loud, actionable warning. The strict path is unchanged: `npm run db:generate`
// fails on error, and the worker refuses to start (`DB_UNREACHABLE` /
// uninitialised client) if the generated client is genuinely missing in a
// deployment that needs it.
const note = [
  "",
  "⚠️  @tern/db: the Prisma client was NOT generated (postinstall continued).",
  "   Typical cause: no network access to binaries.prisma.sh (query-engine CDN).",
  "   Everything that does not touch the database still builds and tests.",
  "   To fix in an environment with egress:",
  "     npm run db:generate",
  "   The worker validates the generated client + database at startup and exits",
  "   loudly if either is missing, so a broken deployment cannot serve traffic.",
  ""
].join("\n");
console.error(note);
process.exit(0);
