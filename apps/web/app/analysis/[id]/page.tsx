
export default function AnalysisReportPage({ params }: { params: { id: string } }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Analysis Report</h1>
      <p className="mt-4 text-neutral-400">Analysis ID: <span className="font-mono text-sm">{params.id}</span></p>
      <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <p className="text-sm text-neutral-500">This analysis is queued or in progress. Results will appear here.</p>
      </div>
    </div>
  );
}
