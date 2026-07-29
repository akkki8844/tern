
export function StatsCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="text-3xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mt-1">{label}</div>
    </div>
  );
}
