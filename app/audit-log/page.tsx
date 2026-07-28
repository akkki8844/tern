const logs = [
  "Repository read pinned to SHA demo-sha",
  "OpenAPI diff generated",
  "Affected usage scan completed",
  "Deterministic patch generated",
  "Test run recorded",
  "PR created in demo mode",
];

export default function AuditLogPage() {
  return (
    <main className="mx-auto w-full max-w-4xl p-6">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <ul className="mt-4 space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm">
        {logs.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
    </main>
  );
}
