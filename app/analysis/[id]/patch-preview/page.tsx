const patches = [
  {
    file: "src/acmeClient.ts",
    patch: `- const url = \`/v1/charges/${"${chargeId}"}\`\n+ const url = \`/v2/payments/${"${chargeId}"}\`\n+ currency: \"USD\"\n- statusText\n+ state`,
  },
];

export default function PatchPreviewPage() {
  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">Patch preview</h1>
      <div className="mt-4 space-y-4">
        {patches.map((patch) => (
          <article key={patch.file} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="font-medium">{patch.file}</h2>
            <pre className="mt-2 overflow-x-auto text-xs text-zinc-300">{patch.patch}</pre>
          </article>
        ))}
      </div>
    </main>
  );
}
