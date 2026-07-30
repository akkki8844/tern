
import { AuditEntry } from "./types";
import { getLogger } from "./logger";
const logger = getLogger("audit");

export class AuditLog {
  private entries: AuditEntry[] = [];
  private maxSize = 100000;
  log(actor: string, action: string, resource: string, resourceId: string, metadata: Record<string, unknown> = {}): AuditEntry {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      actor,
      action,
      resource,
      resourceId,
      metadata,
      timestamp: new Date()
    };
    if (this.entries.length >= this.maxSize) this.entries.shift();
    this.entries.push(entry);
    logger.info("audit entry", { audit: entry });
    return entry;
  }
  list(resource?: string, resourceId?: string): AuditEntry[] {
    return this.entries.filter(e => (!resource || e.resource === resource) && (!resourceId || e.resourceId === resourceId));
  }
}
