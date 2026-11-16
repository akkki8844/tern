-- Capibara initial schema.
--
-- This file is applied with `prisma migrate deploy`. It is also applied verbatim by
-- the job-store test suite against an embedded PostgreSQL instance, so any syntax or
-- constraint error here fails CI immediately.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "PipelineStage" AS ENUM ('DISCOVER', 'DIFF', 'SCAN', 'PLAN', 'MIGRATE', 'VALIDATE', 'TEST', 'PUBLISH');
CREATE TYPE "ChangeSeverity" AS ENUM ('BREAKING', 'RISKY', 'SAFE');
CREATE TYPE "UsageConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "PatchSource" AS ENUM ('DETERMINISTIC', 'AI_FALLBACK');
CREATE TYPE "ValidationOutcome" AS ENUM ('PENDING', 'PASSED', 'FAILED');
CREATE TYPE "PullRequestStatus" AS ENUM ('OPEN', 'CLOSED', 'MERGED');
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");
CREATE INDEX "User_login_idx" ON "User"("login");

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- ---------------------------------------------------------------------------
-- Installations and repositories
-- ---------------------------------------------------------------------------
CREATE TABLE "Installation" (
    "id" TEXT NOT NULL,
    "githubId" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'User',
    "ownerId" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Installation_githubId_key" ON "Installation"("githubId");
CREATE INDEX "Installation_ownerId_idx" ON "Installation"("ownerId");
CREATE INDEX "Installation_deletedAt_idx" ON "Installation"("deletedAt");

CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "githubId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Repository_githubId_key" ON "Repository"("githubId");
CREATE UNIQUE INDEX "Repository_owner_name_key" ON "Repository"("owner", "name");
CREATE INDEX "Repository_installationId_idx" ON "Repository"("installationId");

CREATE TABLE "OpenApiSpec" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'yaml',
    "version" TEXT NOT NULL DEFAULT 'unknown',
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpenApiSpec_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OpenApiSpec_repositoryId_commitSha_path_key" ON "OpenApiSpec"("repositoryId", "commitSha", "path");
CREATE INDEX "OpenApiSpec_repositoryId_idx" ON "OpenApiSpec"("repositoryId");
CREATE INDEX "OpenApiSpec_contentHash_idx" ON "OpenApiSpec"("contentHash");

-- ---------------------------------------------------------------------------
-- Analysis lifecycle
-- ---------------------------------------------------------------------------
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "baseSpecId" TEXT,
    "headSpecId" TEXT,
    "baseCommitSha" TEXT NOT NULL,
    "headCommitSha" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "currentStage" "PipelineStage",
    "idempotencyKey" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'webhook',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AnalysisRun_idempotencyKey_key" ON "AnalysisRun"("idempotencyKey");
CREATE INDEX "AnalysisRun_repositoryId_createdAt_idx" ON "AnalysisRun"("repositoryId", "createdAt");
CREATE INDEX "AnalysisRun_status_idx" ON "AnalysisRun"("status");

CREATE TABLE "StageRun" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "stage" "PipelineStage" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "output" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StageRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StageRun_analysisRunId_stage_attempt_key" ON "StageRun"("analysisRunId", "stage", "attempt");
CREATE INDEX "StageRun_analysisRunId_idx" ON "StageRun"("analysisRunId");

CREATE TABLE "BreakingChange" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "method" TEXT,
    "operationId" TEXT,
    "description" TEXT NOT NULL,
    "severity" "ChangeSeverity" NOT NULL DEFAULT 'BREAKING',
    "oldValue" JSONB,
    "newValue" JSONB,
    "migrationHint" TEXT,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BreakingChange_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BreakingChange_analysisRunId_fingerprint_key" ON "BreakingChange"("analysisRunId", "fingerprint");
CREATE INDEX "BreakingChange_analysisRunId_idx" ON "BreakingChange"("analysisRunId");

CREATE TABLE "AffectedUsage" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "breakingChangeId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "column" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "importPath" TEXT,
    "snippet" TEXT NOT NULL,
    "confidence" "UsageConfidence" NOT NULL DEFAULT 'MEDIUM',
    "operationId" TEXT,
    "httpMethod" TEXT,
    "pathPattern" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AffectedUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffectedUsage_breakingChangeId_filePath_line_column_key" ON "AffectedUsage"("breakingChangeId", "filePath", "line", "column");
CREATE INDEX "AffectedUsage_analysisRunId_idx" ON "AffectedUsage"("analysisRunId");

CREATE TABLE "Migration" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "strategy" TEXT NOT NULL DEFAULT 'deterministic',
    "plannedCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "aiFallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Migration_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Migration_analysisRunId_idx" ON "Migration"("analysisRunId");

CREATE TABLE "Patch" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "breakingChangeId" TEXT,
    "affectedUsageId" TEXT,
    "filePath" TEXT NOT NULL,
    "source" "PatchSource" NOT NULL DEFAULT 'DETERMINISTIC',
    "appliedRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "linesChanged" INTEGER NOT NULL DEFAULT 0,
    "diff" TEXT NOT NULL,
    "baseContentHash" TEXT NOT NULL,
    "resultContentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Patch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Patch_migrationId_filePath_key" ON "Patch"("migrationId", "filePath");
CREATE INDEX "Patch_migrationId_idx" ON "Patch"("migrationId");

CREATE TABLE "ValidationResult" (
    "id" TEXT NOT NULL,
    "patchId" TEXT NOT NULL,
    "validator" TEXT NOT NULL,
    "outcome" "ValidationOutcome" NOT NULL DEFAULT 'PENDING',
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ValidationResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ValidationResult_patchId_validator_key" ON "ValidationResult"("patchId", "validator");
CREATE INDEX "ValidationResult_patchId_idx" ON "ValidationResult"("patchId");

CREATE TABLE "SandboxRun" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "stdoutExcerpt" TEXT NOT NULL DEFAULT '',
    "stderrExcerpt" TEXT NOT NULL DEFAULT '',
    "testSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SandboxRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SandboxRun_analysisRunId_idx" ON "SandboxRun"("analysisRunId");

CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "status" "PullRequestStatus" NOT NULL DEFAULT 'OPEN',
    "mergedAt" TIMESTAMP(3),
    "mergedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PullRequest_analysisRunId_key" ON "PullRequest"("analysisRunId");
CREATE UNIQUE INDEX "PullRequest_repositoryId_number_key" ON "PullRequest"("repositoryId", "number");
CREATE INDEX "PullRequest_repositoryId_idx" ON "PullRequest"("repositoryId");

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "idempotencyKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorDetails" JSONB,
    "analysisRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
CREATE INDEX "Job_status_availableAt_priority_idx" ON "Job"("status", "availableAt", "priority");
CREATE INDEX "Job_status_leaseExpiresAt_idx" ON "Job"("status", "leaseExpiresAt");
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");
CREATE INDEX "Job_analysisRunId_idx" ON "Job"("analysisRunId");

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "installationId" INTEGER,
    "repositoryFullName" TEXT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "jobId" TEXT,
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookEvent_deliveryId_key" ON "WebhookEvent"("deliveryId");
CREATE INDEX "WebhookEvent_event_receivedAt_idx" ON "WebhookEvent"("event", "receivedAt");
CREATE INDEX "WebhookEvent_installationId_idx" ON "WebhookEvent"("installationId");

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "userId" TEXT,
    "installationId" TEXT,
    "repositoryId" TEXT,
    "analysisRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_actor_idx" ON "AuditLog"("actor");

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Installation" ADD CONSTRAINT "Installation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpenApiSpec" ADD CONSTRAINT "OpenApiSpec_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_baseSpecId_fkey" FOREIGN KEY ("baseSpecId") REFERENCES "OpenApiSpec"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_headSpecId_fkey" FOREIGN KEY ("headSpecId") REFERENCES "OpenApiSpec"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StageRun" ADD CONSTRAINT "StageRun_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BreakingChange" ADD CONSTRAINT "BreakingChange_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AffectedUsage" ADD CONSTRAINT "AffectedUsage_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AffectedUsage" ADD CONSTRAINT "AffectedUsage_breakingChangeId_fkey" FOREIGN KEY ("breakingChangeId") REFERENCES "BreakingChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Migration" ADD CONSTRAINT "Migration_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Patch" ADD CONSTRAINT "Patch_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "Migration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Patch" ADD CONSTRAINT "Patch_breakingChangeId_fkey" FOREIGN KEY ("breakingChangeId") REFERENCES "BreakingChange"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Patch" ADD CONSTRAINT "Patch_affectedUsageId_fkey" FOREIGN KEY ("affectedUsageId") REFERENCES "AffectedUsage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ValidationResult" ADD CONSTRAINT "ValidationResult_patchId_fkey" FOREIGN KEY ("patchId") REFERENCES "Patch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SandboxRun" ADD CONSTRAINT "SandboxRun_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
