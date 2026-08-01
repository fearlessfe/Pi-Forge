import path from "node:path";
import { Parser, type ReadEntry } from "tar";
import type {
  PluginContentScanReport,
  PluginSecurityCategory,
  PluginSecurityConfidence,
  PluginSecurityFinding,
  PluginSecuritySeverity,
} from "../src/contracts.js";

const maxScannedFileBytes = 2 * 1024 * 1024;
const maxScannedTotalBytes = 20 * 1024 * 1024;
const maxFindings = 200;
const textExtensions = new Set([
  ".bash", ".cjs", ".css", ".cts", ".html", ".js", ".json", ".jsonc", ".jsx", ".md", ".mjs", ".mts",
  ".ps1", ".py", ".sh", ".svg", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml", ".zsh",
]);
const codeExtensions = new Set([".bash", ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ps1", ".py", ".sh", ".ts", ".tsx", ".zsh"]);

type ScanRule = {
  ruleId: string;
  category: PluginSecurityCategory;
  severity: PluginSecuritySeverity;
  confidence: PluginSecurityConfidence;
  pattern: RegExp;
  message: string;
  remediation: string;
  codeOnly?: boolean;
  accept?: (match: string) => boolean;
};

function looksLikeRealToken(match: string): boolean {
  const normalized = match.toLowerCase();
  if (/(?:example|placeholder|replace|your[_-]?token|dummy|xxxx)/.test(normalized)) return false;
  const body = match.replace(/^(?:sk-(?:proj-)?|sk-ant-|gh[pousr]_|github_pat_|npm_|glpat-|AKIA)/, "");
  return new Set(body).size >= 8;
}

const rules: ScanRule[] = [
  {
    ruleId: "secret-private-key",
    category: "secrets",
    severity: "critical",
    confidence: "high",
    pattern: /-----BEGIN ((?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)-----\s+[A-Za-z0-9+/=\r\n]{128,}\s+-----END \1-----/g,
    message: "文件包含私钥正文。",
    remediation: "移除私钥并轮换相关凭据；插件包中只能保留无效示例占位符。",
  },
  {
    ruleId: "secret-service-token",
    category: "secrets",
    severity: "critical",
    confidence: "high",
    pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
    message: "文件包含疑似真实服务凭据。",
    remediation: "删除凭据、立即轮换，并通过宿主的凭据代理在运行时注入。",
    accept: looksLikeRealToken,
  },
  {
    ruleId: "hidden-unicode-control",
    category: "hidden-content",
    severity: "medium",
    confidence: "high",
    pattern: /[\u200B-\u200D\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g,
    message: "文件包含不可见或双向文本控制字符。",
    remediation: "移除隐藏字符；如确有排版需要，请改用可见、可审查的表示。",
  },
  {
    ruleId: "prompt-ignore-instructions",
    category: "prompt-injection",
    severity: "high",
    confidence: "medium",
    pattern: /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|messages?)\b/gi,
    message: "内容包含典型的指令覆盖语句。",
    remediation: "删除指令覆盖内容，或将安全研究样例隔离到明确标注、不会注入 Agent 的 fixture。",
  },
  {
    ruleId: "safety-bypass",
    category: "permissions",
    severity: "high",
    confidence: "medium",
    pattern: /(?:dangerously[-_ ]skip[-_ ]permissions|disable.{0,40}(?:approval|sandbox|security|permission)|bypass.{0,40}(?:approval|sandbox|security|permission))/gi,
    message: "内容建议绕过宿主的审批、沙箱或权限控制。",
    remediation: "移除绕过建议，并通过正式的权限和审批合同请求所需能力。",
  },
  {
    ruleId: "mcp-auto-approval",
    category: "mcp",
    severity: "high",
    confidence: "high",
    pattern: /(?:enableAllProjectMcpServers|autoApprove\s*["']?\s*:\s*true|dangerouslyAllow[^\n]{0,60}mcp)/gi,
    message: "配置可能自动批准项目 MCP Server。",
    remediation: "移除自动批准；MCP Server 必须经过项目可信校验和逐项授权。",
  },
  {
    ruleId: "permission-wildcard",
    category: "permissions",
    severity: "high",
    confidence: "high",
    pattern: /(?:Bash\(\s*\*\s*\)|permissions?[^\n]{0,80}(?:allow|grant)[^\n]{0,40}["']\*["'])/gi,
    message: "配置申请了无边界的通配权限。",
    remediation: "改为列出完成任务所需的最小工具、命令和路径范围。",
  },
  {
    ruleId: "remote-shell-pipeline",
    category: "execution",
    severity: "high",
    confidence: "medium",
    pattern: /\b(?:curl|wget)\b[^\n]{0,240}(?:\||&&|;)\s*(?:sudo\s+)?(?:ba|z|k|fi)?sh\b/gi,
    message: "内容包含下载后直接交给 Shell 执行的命令。",
    remediation: "固定来源和摘要，先下载并验证内容，再通过明确审批执行。",
  },
  {
    ruleId: "reverse-shell",
    category: "execution",
    severity: "high",
    confidence: "high",
    pattern: /(?:\bnc\s+[^\n]{0,120}\s-e\s|\/dev\/tcp\/|\bbash\s+-i\b)/gi,
    message: "内容包含常见的反向 Shell 模式。",
    remediation: "移除远程 Shell 行为；安全研究样例必须隔离为不可执行 fixture。",
  },
  {
    ruleId: "sensitive-path-access",
    category: "permissions",
    severity: "medium",
    confidence: "medium",
    pattern: /(?:~|\$HOME|process\.env\.HOME)[/\\]\.(?:ssh|aws|gnupg|config[/\\]gcloud)\b/gi,
    message: "内容引用了用户主目录中的敏感凭据路径。",
    remediation: "通过宿主凭据代理请求最小权限，不要直接读取用户凭据目录。",
  },
  {
    ruleId: "process-execution-api",
    category: "execution",
    severity: "medium",
    confidence: "high",
    pattern: /(?:node:child_process|require\(["']child_process["']\)|\b(?:execSync|spawnSync)\s*\(|\bBun\.spawn\s*\(|\bDeno\.Command\s*\()/g,
    message: "Extension 使用了本地进程执行 API。",
    remediation: "确认命令、参数、工作目录和环境变量均受宿主权限策略约束。",
    codeOnly: true,
  },
  {
    ruleId: "network-api",
    category: "network",
    severity: "low",
    confidence: "high",
    pattern: /(?:\bfetch\s*\(|node:https|require\(["']https?["']\)|\baxios\s*\()/g,
    message: "Extension 使用了网络访问 API。",
    remediation: "确认目标域名和发送数据，并通过宿主网络审批与脱敏策略执行。",
    codeOnly: true,
  },
];

function safeArchivePath(entry: ReadEntry): string {
  const raw = entry.path.replace(/^\.\//, "");
  if (!raw || raw.includes("\0") || raw.includes("\\") || path.posix.isAbsolute(raw) || raw.split("/").includes("..")) {
    throw new Error(`插件安全扫描遇到越界路径：${entry.path}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || (normalized !== "package" && !normalized.startsWith("package/"))) {
    throw new Error(`插件安全扫描遇到越界路径：${entry.path}`);
  }
  return normalized;
}

function isTextPath(filePath: string): boolean {
  const extension = path.posix.extname(filePath).toLowerCase();
  return path.posix.basename(filePath) === "package.json" || extension === "" || textExtensions.has(extension);
}

function isCodePath(filePath: string): boolean {
  return codeExtensions.has(path.posix.extname(filePath).toLowerCase());
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (content.charCodeAt(cursor) === 10) line += 1;
  return line;
}

function scanContent(filePath: string, bytes: Buffer): PluginSecurityFinding[] {
  if (bytes.includes(0)) return [];
  const content = bytes.toString("utf8");
  const findings: PluginSecurityFinding[] = [];
  for (const rule of rules) {
    if (rule.codeOnly && !isCodePath(filePath)) continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of content.matchAll(pattern)) {
      if (rule.accept && !rule.accept(match[0])) continue;
      findings.push({
        ruleId: rule.ruleId,
        category: rule.category,
        severity: rule.severity,
        confidence: rule.confidence,
        path: filePath.replace(/^package\//, ""),
        line: lineAt(content, match.index ?? 0),
        message: rule.message,
        remediation: rule.remediation,
      });
      if (findings.length >= maxFindings) return findings;
    }
  }
  return findings;
}

export function scanPluginTarball(bytes: Buffer): Promise<PluginContentScanReport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let scannedFiles = 0;
    let scannedBytes = 0;
    let skippedFiles = 0;
    let truncated = false;
    const findings: PluginSecurityFinding[] = [];
    let parser: Parser;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const normalized = error instanceof Error ? error : new Error(String(error));
      parser?.abort(normalized);
      reject(normalized);
    };

    const addCoverageFinding = (filePath: string, message: string) => {
      if (findings.length >= maxFindings) {
        truncated = true;
        return;
      }
      if (findings.some((finding) => finding.ruleId === "scan-coverage" && finding.path === filePath)) return;
      findings.push({
        ruleId: "scan-coverage",
        category: "coverage",
        severity: "high",
        confidence: "high",
        path: filePath.replace(/^package\//, ""),
        line: 1,
        message,
        remediation: "缩小资源文件，或拆分插件后重新扫描，确保所有可执行和指令内容均被检查。",
      });
    };

    parser = new Parser({
      strict: true,
      maxDecompressionRatio: 100,
      onReadEntry: (entry) => {
        try {
          const filePath = safeArchivePath(entry);
          if ((entry.type !== "File" && entry.type !== "OldFile") || !isTextPath(filePath)) {
            entry.resume();
            return;
          }
          if (entry.size > maxScannedFileBytes) {
            skippedFiles += 1;
            truncated = true;
            addCoverageFinding(filePath, "文本资源超过单文件扫描上限，未完成内容检查。");
            entry.resume();
            return;
          }
          if (scannedBytes + entry.size > maxScannedTotalBytes) {
            skippedFiles += 1;
            truncated = true;
            addCoverageFinding(filePath, "插件文本资源超过总扫描预算，未完成内容检查。");
            entry.resume();
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          entry.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxScannedFileBytes) {
              fail(new Error("插件安全扫描读取的文件大小与归档声明不一致。"));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          entry.on("end", () => {
            if (settled) return;
            const content = Buffer.concat(chunks, received);
            if (content.includes(0) || content.toString("utf8").includes("\uFFFD")) {
              skippedFiles += 1;
              truncated = true;
              addCoverageFinding(filePath, "文本候选资源不是有效的 UTF-8 文本，未完成内容检查。");
              return;
            }
            scannedFiles += 1;
            scannedBytes += content.length;
            if (findings.length < maxFindings) findings.push(...scanContent(filePath, content).slice(0, maxFindings - findings.length));
            if (findings.length >= maxFindings) truncated = true;
          });
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
      const blocked = findings.some((finding) => finding.severity === "critical" && finding.confidence === "high");
      settled = true;
      resolve({
        scannerVersion: 1,
        status: blocked ? "blocked" : findings.length > 0 ? "review" : "clean",
        scannedAt: new Date().toISOString(),
        scannedFiles,
        scannedBytes,
        skippedFiles,
        truncated,
        findings,
      });
    });
    parser.end(bytes);
  });
}
