const cards = [
  { label: "Connected repositories", value: "1" },
  { label: "Breaking changes detected", value: "3" },
  { label: "Migration PRs", value: "1" },
  { label: "Latest confidence", value: "89%" },
];

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-6xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>
      <div className="grid gap-4 md:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs text-zinc-400">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold">{card.value}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
