import type { PrismaClient } from "@prisma/client";
import { getLogger, internalMessageOf, redactValue } from "@tern/shared";

const logger = getLogger("audit");

export interface AuditRecord {
  actor: string;
  actorType?: "user" | "system" | "worker" | "github";
  action: string;
  resourceType: string;
  resourceId: string;
  outcome?: "success" | "failure" | "denied";
  metadata?: Record<string, unknown>;
  userId?: string;
  installationId?: string;
  repositoryId?: string;
  analysisRunId?: string;
}

/**
 * Durable audit trail.
 *
 * Audit records live in PostgreSQL, not in process memory: an audit log that
 * disappears when a worker restarts is not an audit log. Metadata is redacted
 * before it is written, so an audit entry can never become a secret leak.
 */
export class AuditLogger {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditRecord): Promise<void> {
    const metadata = (redactValue(entry.metadata ?? {}) ?? {}) as Record<string, unknown>;
    try {
      await this.prisma.auditLog.create({
        data: {
          actor: entry.actor,
          actorType: entry.actorType ?? "system",
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          outcome: entry.outcome ?? "success",
          metadata: metadata as never,
          userId: entry.userId ?? null,
          installationId: entry.installationId ?? null,
          repositoryId: entry.repositoryId ?? null,
          analysisRunId: entry.analysisRunId ?? null
        }
      });
    } catch (error) {
      // An audit write must never abort the operation being audited, but it must be
      // loudly visible: a silent audit failure is a compliance hole.
      logger.error("failed to persist audit record", {
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        reason: internalMessageOf(error)
      });
    }
  }
}
