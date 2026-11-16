import { prisma } from "./api/_runtime";

/**
 * Server-side dashboard data access.
 *
 * Every function returns a discriminated result instead of throwing: the
 * dashboard must render a degraded, truthful state when the database is
 * unreachable (fresh deploy, migration pending, outage) rather than a 500.
 * Nothing here logs or renders secret material — counts, names and statuses only.
 */

export type DataResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

async function guarded<T>(query: () => Promise<T>): Promise<DataResult<T>> {
  try {
    return { ok: true, data: await query() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Prisma's ungenerated-client and connectivity errors are expected in a
    // degraded deployment; surface them as a state, not a crash.
    return { ok: false, reason: message.slice(0, 300) };
  }
}

export interface DashboardStats {
  repositories: number;
  analysisRuns: number;
  pullRequests: number;
  recentRuns: Array<{
    id: string;
    status: string;
    repository: { owner: string; name: string };
    createdAt: Date;
  }>;
}

export function dashboardStats(): Promise<DataResult<DashboardStats>> {
  return guarded(async () => {
    const db = prisma();
    const [repositories, analysisRuns, pullRequests, recentRuns] = await Promise.all([
      db.repository.count(),
      db.analysisRun.count(),
      db.pullRequest.count(),
      db.analysisRun.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, status: true, createdAt: true, repository: { select: { owner: true, name: true } } }
      })
    ]);
    return { repositories, analysisRuns, pullRequests, recentRuns };
  });
}

export interface RepositoryRow {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  archivedAt: Date | null;
  createdAt: Date;
}

export function listRepositories(): Promise<DataResult<RepositoryRow[]>> {
  return guarded(async () => {
    const rows = await prisma().repository.findMany({
      orderBy: [{ archivedAt: "asc" }, { createdAt: "desc" }],
      take: 100,
      select: {
        id: true,
        owner: true,
        name: true,
        defaultBranch: true,
        isPrivate: true,
        archivedAt: true,
        createdAt: true
      }
    });
    return rows;
  });
}

export interface PullRequestRow {
  id: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  status: string;
  createdAt: Date;
  repository: { owner: string; name: string };
}

export function listPullRequests(): Promise<DataResult<PullRequestRow[]>> {
  return guarded(async () => {
    const rows = await prisma().pullRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        number: true,
        title: true,
        url: true,
        branch: true,
        status: true,
        createdAt: true,
        repository: { select: { owner: true, name: true } }
      }
    });
    return rows;
  });
}

export interface AnalysisDetail {
  id: string;
  status: string;
  baseCommitSha: string;
  headCommitSha: string;
  createdAt: Date;
  repository: { owner: string; name: string };
  changes: Array<{ id: string; type: string; severity: string; description: string }>;
  usages: Array<{ id: string; filePath: string; line: number; confidence: string; symbol: string }>;
  stages: Array<{ stage: string; status: string; durationMs: number | null }>;
}

/** One analysis run with its changes, detected usages and stage timeline. */
export function analysisDetail(id: string): Promise<DataResult<AnalysisDetail | null>> {
  return guarded(async () => {
    const run = await prisma().analysisRun.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        baseCommitSha: true,
        headCommitSha: true,
        createdAt: true,
        repository: { select: { owner: true, name: true } },
        changes: { select: { id: true, type: true, severity: true, description: true } },
        usages: {
          select: { id: true, filePath: true, line: true, confidence: true, symbol: true },
          take: 200
        },
        stageRuns: { select: { stage: true, status: true, durationMs: true }, orderBy: { createdAt: "asc" } }
      }
    });
    return run;
  });
}
