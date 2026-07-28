export default function SettingsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <p className="font-medium">Disconnect GitHub App</p>
        <p className="text-sm text-zinc-400">Deletes installation metadata and analysis records for this workspace.</p>
      </div>
    </main>
  );
}
