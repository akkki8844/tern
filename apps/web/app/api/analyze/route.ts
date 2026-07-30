import { NextResponse } from "next/server";
import { getConfig } from "@tern/shared";
import { createGitHubService } from "@tern/github";
import { AnalysisQueue } from "@tern/worker";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { owner, repo, oldSpecPath, newSpecPath } = body;
    const cfg = getConfig();
    const github = await createGitHubService();
    const repoData = await github.getRepository(123456, owner, repo);
    const queue = new AnalysisQueue();
    const analysisId = `analysis-${Date.now()}`;
    const repository = github.toRepositoryRef(repoData, 123456);
    await queue.enqueue({
      analysisId,
      repository,
      oldSpecPath: oldSpecPath || "demo/acmepay-openapi-old.yaml",
      newSpecPath: newSpecPath || "demo/acmepay-openapi-new.yaml",
      baseCommitSha: "abc123",
      headCommitSha: "abc123"
    });
    await queue.close();
    return NextResponse.json({ id: analysisId, status: "queued" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
