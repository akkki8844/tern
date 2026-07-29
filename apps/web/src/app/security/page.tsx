
import { PageShell } from "@/components/page-shell";
import { SecurityCard } from "@/components/security-card";

export default function SecurityPage() {
  return (
    <PageShell title="Security" subtitle="How Tern protects your code and secrets.">
      <div className="grid gap-4 md:grid-cols-2">
        <SecurityCard title="Secret redaction" description="All logs and diffs are scanned for API keys, tokens, and credentials before storage." />
        <SecurityCard title="Sandboxed execution" description="Migration patches are tested in isolated environments with no network access by default." />
        <SecurityCard title="Patch validation" description="Patches cannot modify lockfiles, CI, secrets, Docker, or unrelated files." />
        <SecurityCard title="Human review" description="Every pull request is left open for human review; Tern never auto-merges." />
      </div>
    </PageShell>
  );
}
