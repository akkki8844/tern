
export default function PatchPreviewPage({ params }: { params: { id: string } }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Patch Preview</h1>
      <p className="mt-4 text-neutral-400">Patch ID: <span className="font-mono text-sm">{params.id}</span></p>
    </div>
  );
}
