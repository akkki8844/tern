import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { getLogger, WorkspaceError, isWithin, normalizeRelativePath, resolveWithin, internalMessageOf } from "@tern/shared";
import type { Workspace, WorkspaceProvider } from "@tern/shared";

const logger = getLogger("workspace");

const WORKSPACE_PREFIX = "tern-ws-";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Filesystem-backed workspaces.
 *
 * Guarantees
 *  - every workspace lives directly under a single configured root
 *  - a workspace directory name is generated, never taken from user input
 *  - every path derived from a workspace is resolved and proven to stay inside it
 *  - a workspace can be disposed more than once, and disposal never deletes anything
 *    outside the root
 *  - orphans left by crashed processes can be reaped by age
 */
export class FilesystemWorkspaceProvider implements WorkspaceProvider {
  readonly root: string;

  constructor(root: string) {
    if (!root || !isAbsolute(root)) {
      throw new WorkspaceError("Workspace root must be an absolute path", {
        code: "WORKSPACE_ROOT_INVALID",
        details: { root }
      });
    }
    // Refuse obviously dangerous roots: deleting under these would be catastrophic.
    const normalized = resolve(root);
    if (normalized === "/" || normalized === dirname(normalized)) {
      throw new WorkspaceError("Workspace root must not be a filesystem root", { code: "WORKSPACE_ROOT_INVALID" });
    }
    this.root = normalized;
  }

  async create(ownerKey: string): Promise<Workspace> {
    await mkdir(this.root, { recursive: true, mode: DIR_MODE });
    // The owner key is only used to make directories recognisable in logs; it is
    // reduced to a safe token and never used as a path component verbatim.
    const token = ownerKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "job";
    const path = await mkdtemp(join(this.root, `${WORKSPACE_PREFIX}${token}-`));
    logger.info("workspace created", { workspacePath: path, owner: token });
    return new FilesystemWorkspace(path, this.root);
  }

  async reapOrphans(olderThanMs: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw new WorkspaceError("Failed to list the workspace root", {
        code: "WORKSPACE_LIST_FAILED",
        cause: error
      });
    }

    const cutoff = Date.now() - Math.max(0, olderThanMs);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.startsWith(WORKSPACE_PREFIX)) continue;
      const path = join(this.root, entry);
      if (!isWithin(this.root, path)) continue;
      try {
        const info = await stat(path);
        if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
        await rm(path, { recursive: true, force: true, maxRetries: 3 });
        removed += 1;
        logger.warn("removed orphaned workspace", { workspacePath: path });
      } catch (error) {
        logger.warn("failed to reap workspace", { workspacePath: path, reason: internalMessageOf(error) });
      }
    }
    return removed;
  }
}

class FilesystemWorkspace implements Workspace {
  readonly id: string;
  private disposed = false;

  constructor(
    readonly path: string,
    private readonly root: string
  ) {
    this.id = path.slice(path.lastIndexOf("/") + 1);
  }

  resolve(relativePath: string): string {
    this.assertUsable();
    return resolveWithin(this.path, relativePath);
  }

  async readFile(relativePath: string): Promise<string> {
    const target = this.resolve(relativePath);
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      throw new WorkspaceError("Failed to read a workspace file", {
        code: "WORKSPACE_READ_FAILED",
        details: { relativePath: normalizeRelativePath(relativePath), reason: internalMessageOf(error) },
        cause: error
      });
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const target = this.resolve(relativePath);
    await mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
    await writeFile(target, content, { encoding: "utf8", mode: FILE_MODE });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Defence in depth: never delete anything that is not inside the configured root.
    if (!isWithin(this.root, this.path) || this.path === this.root) {
      logger.error("refusing to dispose a workspace outside the root", { workspacePath: this.path });
      return;
    }
    try {
      await rm(this.path, { recursive: true, force: true, maxRetries: 3 });
      logger.info("workspace disposed", { workspacePath: this.path });
    } catch (error) {
      logger.warn("workspace disposal failed", { workspacePath: this.path, reason: internalMessageOf(error) });
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new WorkspaceError("Workspace has been disposed", { code: "WORKSPACE_DISPOSED" });
    }
  }
}

/**
 * Run `fn` with a fresh workspace and dispose it afterwards — on success, on failure
 * and on cancellation. This is the only sanctioned way for a pipeline stage to obtain
 * a workspace, so a leak requires deliberately bypassing the helper.
 */
export async function withWorkspace<T>(
  provider: WorkspaceProvider,
  ownerKey: string,
  fn: (workspace: Workspace) => Promise<T>
): Promise<T> {
  const workspace = await provider.create(ownerKey);
  try {
    return await fn(workspace);
  } finally {
    await workspace.dispose();
  }
}
