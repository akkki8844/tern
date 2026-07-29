
export function Card({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <div className="text-sm text-neutral-400">{title}</div>
      <div className="mt-1 text-3xl font-semibold tracking-tight">{value}</div>
      {subtitle && <div className="mt-1 text-xs text-neutral-500">{subtitle}</div>}
    </div>
  );
}
