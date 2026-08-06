import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserArtifactStore } from "./browser-artifact-store.js";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-browser-artifacts-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("BrowserArtifactStore", () => {
  it("writes testable owner, TTL, size, and path metadata", async () => {
    const store = new BrowserArtifactStore(directory, {
      now: () => Date.parse("2026-08-06T01:00:00.000Z"),
      id: () => "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      ttlMs: 60_000,
    });

    const metadata = await store.save(new Uint8Array([1, 2, 3]), "browser-workbench");

    expect(metadata).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      owner: "browser-workbench",
      path: path.join(directory, "pi-browser-annotation-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.png"),
      createdAt: "2026-08-06T01:00:00.000Z",
      expiresAt: "2026-08-06T01:01:00.000Z",
      ttlMs: 60_000,
      byteSize: 3,
    });
    await expect(fs.readFile(metadata.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("removes expired and unreferenced screenshots during startup cleanup", async () => {
    let now = 1_000;
    const store = new BrowserArtifactStore(directory, {
      now: () => now,
      id: () => "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      ttlMs: 100,
    });
    const expired = await store.save(new Uint8Array([1]), "agent:conversation-1");
    const orphan = path.join(directory, "pi-browser-annotation-deadbeef.png");
    await fs.writeFile(orphan, new Uint8Array([2]));
    now = 1_101;

    await expect(store.cleanup()).resolves.toMatchObject({ removedExpired: 1, removedOrphaned: 1, retained: 0 });
    await expect(fs.stat(expired.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("evicts oldest screenshots to enforce count and byte caps", async () => {
    let now = 1_000;
    const ids = [
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-cccc-cccccccccccc",
    ];
    const store = new BrowserArtifactStore(directory, {
      now: () => now++,
      id: () => ids.shift()!,
      ttlMs: 10_000,
      maxCount: 2,
      maxBytes: 4,
    });
    const oldest = await store.save(new Uint8Array([1, 1]), "owner");
    await store.save(new Uint8Array([2, 2]), "owner");
    await store.save(new Uint8Array([3, 3]), "owner");

    await expect(fs.stat(oldest.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.cleanup()).resolves.toMatchObject({ retained: 2, retainedBytes: 4 });
  });

  it("rejects a screenshot that cannot fit within the byte limit", async () => {
    const store = new BrowserArtifactStore(directory, { maxBytes: 2 });
    await expect(store.save(new Uint8Array([1, 2, 3]), "owner")).rejects.toThrow("超过容量上限");
  });
});
