import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/contracts.js";
import { FileChangeTracker } from "./file-changes.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("FileChangeTracker", () => {
  it("merges repeated edits to the same file into one reviewable change", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-file-changes-"));
    temporaryDirectories.push(cwd);
    const filePath = path.join(cwd, "notes.txt");
    fs.writeFileSync(filePath, "before\n");
    const events: AgentEvent[] = [];
    const tracker = new FileChangeTracker((event) => events.push(event), vi.fn());
    tracker.setSessionCwd(cwd);

    tracker.captureFileMutationStart("call-1", "edit", { path: "notes.txt" });
    fs.writeFileSync(filePath, "intermediate\n");
    tracker.captureFileMutationEnd("run-1", "call-1", "edit", {}, false);

    tracker.captureFileMutationStart("call-2", "edit", { path: "notes.txt" });
    fs.writeFileSync(filePath, "final\n");
    tracker.captureFileMutationEnd("run-1", "call-2", "edit", {}, false);

    const changes = tracker.listChanges("run-1");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      callId: "call-1",
      relativePath: "notes.txt",
      kind: "modified",
      status: "pending",
      revertible: true,
    });
    expect(changes[0].patch).toContain("-before");
    expect(changes[0].patch).toContain("+final");
    expect(changes[0].patch).not.toContain("intermediate");
    expect(events.filter((event) => event.type === "changes.updated").at(-1)).toMatchObject({
      changes: [expect.objectContaining({ id: changes[0].id })],
    });

    expect(tracker.revertChanges([changes[0].id])[0].status).toBe("reverted");
    expect(fs.readFileSync(filePath, "utf8")).toBe("before\n");
  });

  it("keeps changes to the same path separate across runs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-file-changes-runs-"));
    temporaryDirectories.push(cwd);
    const filePath = path.join(cwd, "notes.txt");
    fs.writeFileSync(filePath, "before\n");
    const tracker = new FileChangeTracker(vi.fn(), vi.fn());
    tracker.setSessionCwd(cwd);

    tracker.captureFileMutationStart("call-1", "edit", { path: "notes.txt" });
    fs.writeFileSync(filePath, "first run\n");
    tracker.captureFileMutationEnd("run-1", "call-1", "edit", {}, false);
    tracker.captureFileMutationStart("call-2", "edit", { path: "notes.txt" });
    fs.writeFileSync(filePath, "second run\n");
    tracker.captureFileMutationEnd("run-2", "call-2", "edit", {}, false);

    expect(tracker.listChanges("run-1")).toHaveLength(1);
    expect(tracker.listChanges("run-2")).toHaveLength(1);
  });

  it("removes the review item when later edits restore the original content", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-file-changes-restored-"));
    temporaryDirectories.push(cwd);
    const filePath = path.join(cwd, "notes.txt");
    fs.writeFileSync(filePath, "original\n");
    const tracker = new FileChangeTracker(vi.fn(), vi.fn());
    tracker.setSessionCwd(cwd);

    tracker.captureFileMutationStart("call-1", "edit", { path: "notes.txt" });
    fs.writeFileSync(filePath, "changed\n");
    tracker.captureFileMutationEnd("run-1", "call-1", "edit", {}, false);
    tracker.captureFileMutationStart("call-2", "edit", { path: "notes.txt" });
    fs.writeFileSync(filePath, "original\n");
    tracker.captureFileMutationEnd("run-1", "call-2", "edit", {}, false);

    expect(tracker.listChanges("run-1")).toEqual([]);
  });
});
