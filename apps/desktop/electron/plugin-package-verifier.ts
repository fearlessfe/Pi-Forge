import crypto from "node:crypto";
import path from "node:path";
import { Parser, type ReadEntry } from "tar";
import type { PluginManifest } from "../src/contracts.js";

export const maxPluginTarballBytes = 50 * 1024 * 1024;
const maxPluginExpandedBytes = 200 * 1024 * 1024;
const maxPluginEntries = 10_000;
const maxPackageJsonBytes = 1024 * 1024;
const resourceKeys = ["extensions", "skills", "prompts", "themes"] as const;

type ExpectedPluginPackage = {
  name: string;
  version: string;
  manifest: PluginManifest;
};

function normalizedManifest(value: unknown): PluginManifest {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("插件安装包中的 pi 资源清单格式无效。");
  }
  const input = value as Record<string, unknown>;
  const result: PluginManifest = {};
  for (const key of resourceKeys) {
    if (!(key in input)) continue;
    const entries = input[key];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new Error(`插件安装包中的 ${key} 资源清单格式无效。`);
    }
    result[key] = [...entries] as string[];
  }
  return result;
}

function safeArchivePath(entry: ReadEntry): string {
  const raw = entry.path.replace(/^\.\//, "");
  if (
    !raw
    || raw.includes("\0")
    || raw.includes("\\")
    || path.posix.isAbsolute(raw)
    || entry.absolute
    || raw.split("/").includes("..")
  ) throw new Error(`插件安装包包含越界路径：${entry.path}`);
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || (normalized !== "package" && !normalized.startsWith("package/"))) {
    throw new Error(`插件安装包包含越界路径：${entry.path}`);
  }
  return normalized;
}

function inspectPackageJson(content: string, expected: ExpectedPluginPackage): void {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error("插件安装包中的 package.json 无法解析。");
  }
  if (value.name !== expected.name || value.version !== expected.version) {
    throw new Error("插件安装包中的包名或版本与 Registry 元数据不一致。");
  }
  const actualManifest = normalizedManifest(value.pi);
  if (JSON.stringify(actualManifest) !== JSON.stringify(expected.manifest)) {
    throw new Error("插件安装包中的资源清单与 Registry 元数据不一致。");
  }
}

export function verifySha512Integrity(integrity: string, bytes: Buffer): void {
  const expectedDigests = integrity.trim().split(/\s+/).flatMap((entry) => {
    const separator = entry.indexOf("-");
    if (separator <= 0 || entry.slice(0, separator).toLowerCase() !== "sha512") return [];
    try {
      const digest = Buffer.from(entry.slice(separator + 1), "base64");
      return digest.length === 64 ? [digest] : [];
    } catch {
      return [];
    }
  });
  if (expectedDigests.length === 0) {
    throw new Error("插件注册表未提供有效的 sha512 完整性校验值，已拒绝安装。");
  }
  const actual = crypto.createHash("sha512").update(bytes).digest();
  if (!expectedDigests.some((expected) => crypto.timingSafeEqual(actual, expected))) {
    throw new Error("插件安装包完整性校验失败，与 Registry 记录不一致，已拒绝安装。");
  }
}

export async function readBoundedResponse(response: Response, maximum = maxPluginTarballBytes): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("插件安装包超过 50 MB，已拒绝安装。");
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error("插件安装包超过 50 MB，已拒绝安装。");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("插件安装包超过 50 MB，已拒绝安装。");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function inspectPluginTarball(bytes: Buffer, expected: ExpectedPluginPackage): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let entryCount = 0;
    let expandedBytes = 0;
    let packageJson: Buffer[] | undefined;
    let packageJsonBytes = 0;
    let parser: Parser;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const normalized = error instanceof Error ? error : new Error(String(error));
      parser?.abort(normalized);
      reject(normalized);
    };

    parser = new Parser({
      strict: true,
      maxDecompressionRatio: 100,
      maxMetaEntrySize: maxPackageJsonBytes,
      onReadEntry: (entry) => {
        try {
          entryCount += 1;
          if (entryCount > maxPluginEntries) throw new Error("插件安装包文件数量过多，已拒绝安装。");
          expandedBytes += Math.max(0, entry.size);
          if (expandedBytes > maxPluginExpandedBytes) throw new Error("插件安装包解压后超过 200 MB，已拒绝安装。");
          const archivePath = safeArchivePath(entry);
          if (entry.type === "Link" || entry.type === "SymbolicLink") {
            throw new Error(`插件安装包包含链接条目：${entry.path}`);
          }
          if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "Directory") {
            throw new Error(`插件安装包包含不支持的条目类型：${entry.type}`);
          }
          if (archivePath === "package/package.json") {
            if (entry.type !== "File" && entry.type !== "OldFile") throw new Error("插件安装包的 package.json 不是普通文件。");
            if (packageJson) throw new Error("插件安装包包含重复的 package.json。");
            if (entry.size > maxPackageJsonBytes) throw new Error("插件安装包的 package.json 过大。");
            packageJson = [];
            entry.on("data", (chunk: Buffer) => {
              packageJsonBytes += chunk.length;
              if (packageJsonBytes > maxPackageJsonBytes) {
                fail(new Error("插件安装包的 package.json 过大。"));
                return;
              }
              packageJson?.push(Buffer.from(chunk));
            });
          }
          entry.resume();
        } catch (error) {
          entry.resume();
          fail(error);
        }
      },
    });
    parser.once("error", fail);
    parser.once("finish", () => {
      if (settled) return;
      try {
        if (!packageJson) throw new Error("插件安装包缺少 package/package.json。");
        inspectPackageJson(Buffer.concat(packageJson, packageJsonBytes).toString("utf8"), expected);
        settled = true;
        resolve();
      } catch (error) {
        fail(error);
      }
    });
    parser.end(bytes);
  });
}

export async function downloadAndVerifyPluginTarball(
  fetcher: typeof fetch,
  tarballUrl: string | undefined,
  integrity: string | undefined,
  expected: ExpectedPluginPackage,
): Promise<Buffer> {
  if (!integrity) throw new Error("插件注册表未提供 sha512 完整性校验值，已拒绝安装。");
  if (!tarballUrl) throw new Error("插件注册表未提供安装包下载地址，已拒绝安装。");
  let response: Response;
  try {
    response = await fetcher(tarballUrl);
  } catch (error) {
    throw new Error(`插件安装包下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`插件安装包下载失败（HTTP ${response.status}），已拒绝安装。`);
  const bytes = await readBoundedResponse(response);
  verifySha512Integrity(integrity, bytes);
  await inspectPluginTarball(bytes, expected);
  return bytes;
}
