const breakingChanges = [
  "removed_endpoint /v1/charges/{chargeId}",
  "added_required_request_parameter currency",
  "renamed_response_field statusText → state",
];

const usages = ["src/acmeClient.ts:2", "src/acmeClient.ts:15", "src/paymentService.ts:5"];

export default function AnalysisReportPage() {
  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">Analysis report</h1>
      <p className="mt-2 text-zinc-400">Confidence: 89%</p>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="font-medium">Breaking changes found</h2>
          <ul className="mt-2 space-y-2 text-sm text-zinc-300">
            {breakingChanges.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="font-medium">Affected usages</h2>
          <ul className="mt-2 space-y-2 text-sm text-zinc-300">
            {usages.map((usage) => (
              <li key={usage}>{usage}</li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
