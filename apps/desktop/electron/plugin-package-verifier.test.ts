import { gzipSync } from "node:zlib";
import { Header, type HeaderData } from "tar";
import { describe, expect, it } from "vitest";
import {
  inspectPluginTarball,
  readBoundedResponse,
  verifySha512Integrity,
} from "./plugin-package-verifier.js";

type ArchiveEntry = HeaderData & { content?: string | Buffer };

function archive(entries: ArchiveEntry[]): Buffer {
  const blocks = entries.flatMap((entry) => {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    new Header({
      mode: entry.type === "Directory" ? 0o755 : 0o644,
      mtime: new Date(0),
      ...entry,
      content: undefined,
      size: entry.type === "Directory" || entry.type === "SymbolicLink" || entry.type === "Link"
        ? 0
        : content.length,
    } as HeaderData).encode(header);
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
    return [header, content, padding];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const expected = {
  name: "pi-safe",
  version: "1.2.3",
  manifest: { themes: ["./themes"] },
};

function packageJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: expected.name,
    version: expected.version,
    pi: expected.manifest,
    ...overrides,
  });
}

describe("plugin package verifier", () => {
  it("accepts a bounded package with matching identity and manifest", async () => {
    const bytes = archive([
      { path: "package/", type: "Directory" },
      { path: "package/package.json", type: "File", content: packageJson() },
      { path: "package/themes/index.json", type: "File", content: "{}" },
    ]);

    await expect(inspectPluginTarball(bytes, expected)).resolves.toBeUndefined();
  });

  it("rejects identity and manifest mismatches", async () => {
    const wrongName = archive([
      { path: "package/package.json", type: "File", content: packageJson({ name: "pi-other" }) },
    ]);
    const wrongManifest = archive([
      { path: "package/package.json", type: "File", content: packageJson({ pi: { skills: ["./skills"] } }) },
    ]);

    await expect(inspectPluginTarball(wrongName, expected)).rejects.toThrow("包名或版本");
    await expect(inspectPluginTarball(wrongManifest, expected)).rejects.toThrow("资源清单");
  });

  it("rejects path traversal and files outside the package root", async () => {
    const traversal = archive([
      { path: "../escape", type: "File", content: "unsafe" },
      { path: "package/package.json", type: "File", content: packageJson() },
    ]);
    const wrongRoot = archive([
      { path: "other/package.json", type: "File", content: packageJson() },
    ]);

    await expect(inspectPluginTarball(traversal, expected)).rejects.toThrow(/越界路径|path contains|escaped/);
    await expect(inspectPluginTarball(wrongRoot, expected)).rejects.toThrow("越界路径");
  });

  it("rejects symlinks and missing package metadata", async () => {
    const symlink = archive([
      { path: "package/package.json", type: "File", content: packageJson() },
      { path: "package/themes-link", type: "SymbolicLink", linkpath: "../outside" },
    ]);
    const missing = archive([
      { path: "package/themes/index.json", type: "File", content: "{}" },
    ]);

    await expect(inspectPluginTarball(symlink, expected)).rejects.toThrow("链接条目");
    await expect(inspectPluginTarball(missing, expected)).rejects.toThrow("缺少 package/package.json");
  });

  it("rejects oversized declared and streamed responses", async () => {
    const declared = new Response("small", { headers: { "content-length": "9" } });
    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    }));

    await expect(readBoundedResponse(declared, 8)).rejects.toThrow("超过 50 MB");
    await expect(readBoundedResponse(streamed, 8)).rejects.toThrow("超过 50 MB");
  });

  it("requires a real sha512 digest", () => {
    expect(() => verifySha512Integrity("sha1-deadbeef", Buffer.from("plugin"))).toThrow("sha512");
    expect(() => verifySha512Integrity("sha512-not-a-digest", Buffer.from("plugin"))).toThrow("sha512");
  });
});
