import { NextResponse } from "next/server";
import { createGitHubService } from "@tern/github";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { owner, repo, oldSpecPath, newSpecPath, installationId } = body;
    if (!installationId) {
      return NextResponse.json({ error: "installationId is required" }, { status: 400 });
    }
    const github = await createGitHubService();
    const repoData = await github.getRepository(installationId, owner, repo);
    const analysisId = `analysis-${Date.now()}`;
    const repository = github.toRepositoryRef(repoData, installationId);
    return NextResponse.json({
      id: analysisId,
      status: "queued",
      repository,
      oldSpecPath: oldSpecPath || "demo/acmepay-openapi-old.yaml",
      newSpecPath: newSpecPath || "demo/acmepay-openapi-new.yaml"
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
