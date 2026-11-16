import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityError, WorkspaceError } from "@capibara/shared";
import { FilesystemWorkspaceProvider, withWorkspace } from "./filesystem-workspace.js";

describe("FilesystemWorkspaceProvider", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "capibara-ws-root-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a relative or dangerous root", () => {
    assert.throws(() => new FilesystemWorkspaceProvider("relative/path"), WorkspaceError);
    assert.throws(() => new FilesystemWorkspaceProvider("/"), WorkspaceError);
  });

  it("creates an isolated directory per workspace", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const a = await provider.create("job-1");
    const b = await provider.create("job-1");
    assert.notEqual(a.path, b.path, "two workspaces for the same owner must not share a directory");
    assert.ok(a.path.startsWith(root));
    assert.ok(b.path.startsWith(root));
    await a.dispose();
    await b.dispose();
  });

  it("creates the workspace with owner-only permissions", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const workspace = await provider.create("perm");
    const info = await stat(workspace.path);
    assert.equal(info.mode & 0o777, 0o700);
    await workspace.dispose();
  });

  it("never lets an owner key become a path component", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const workspace = await provider.create("../../etc/passwd");
    assert.ok(workspace.path.startsWith(root), `escaped root: ${workspace.path}`);
    assert.ok(!workspace.path.includes(".."));
    await workspace.dispose();
  });

  it("reads and writes files inside the workspace", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const workspace = await provider.create("io");
    await workspace.writeFile("src/nested/api.ts", "export const x = 1;");
    assert.equal(await workspace.readFile("src/nested/api.ts"), "export const x = 1;");
    await workspace.dispose();
  });

  it("refuses path traversal on read, write and resolve", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const workspace = await provider.create("traversal");
    const outside = join(root, "outside.txt");
    await writeFile(outside, "secret");

    assert.throws(() => workspace.resolve("../outside.txt"), SecurityError);
    await assert.rejects(() => workspace.readFile("../outside.txt"), SecurityError);
    await assert.rejects(() => workspace.writeFile("../evil.txt", "x"), SecurityError);
    await assert.rejects(() => workspace.readFile("/etc/passwd"), SecurityError);
    await assert.rejects(() => workspace.writeFile("a/../../escape.txt", "x"), SecurityError);

    assert.equal(await readFile(outside, "utf8"), "secret", "the file outside the workspace must be untouched");
    await workspace.dispose();
    await rm(outside, { force: true });
  });

  it("cannot reach another workspace", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const victim = await provider.create("victim");
    const attacker = await provider.create("attacker");
    await victim.writeFile("secret.txt", "top secret");

    const victimDir = victim.path.slice(victim.path.lastIndexOf("/") + 1);
    await assert.rejects(() => attacker.readFile(`../${victimDir}/secret.txt`), SecurityError);

    await victim.dispose();
    await attacker.dispose();
  });

  it("removes everything on dispose and tolerates double dispose", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const workspace = await provider.create("dispose");
    await workspace.writeFile("a/b/c.ts", "content");
    const path = workspace.path;
    await workspace.dispose();
    assert.equal(existsSync(path), false);
    await workspace.dispose();
    assert.throws(() => workspace.resolve("a.ts"), WorkspaceError);
  });

  it("disposes the workspace when the body throws", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    let capturedPath = "";
    await assert.rejects(
      withWorkspace(provider, "failing", async (workspace) => {
        capturedPath = workspace.path;
        await workspace.writeFile("x.ts", "x");
        throw new Error("stage failed");
      }),
      /stage failed/
    );
    assert.equal(existsSync(capturedPath), false);
  });

  it("reaps orphaned workspaces older than the cutoff, leaving fresh ones alone", async () => {
    const provider = new FilesystemWorkspaceProvider(root);
    const stale = await provider.create("stale");
    const fresh = await provider.create("fresh");
    const unrelated = join(root, "not-a-workspace");
    await mkdir(unrelated, { recursive: true });

    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(stale.path, old, old);

    const removed = await provider.reapOrphans(30 * 60 * 1000);
    assert.equal(removed, 1);
    assert.equal(existsSync(stale.path), false);
    assert.equal(existsSync(fresh.path), true);
    assert.equal(existsSync(unrelated), true, "directories Capibara did not create must be left alone");

    await fresh.dispose();
    await rm(unrelated, { recursive: true, force: true });
  });
});
