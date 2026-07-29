import fs from "node:fs";
import path from "node:path";
import type { AppearanceTheme } from "../src/contracts.js";

type StoredAppearanceFile = { version: 1; theme: AppearanceTheme };

/* 最近一次界面主题的轻量持久化（docs/design-refresh-apple.md 3.6）：
   createWindow() 据此决定初始背景色，避免浅色用户启动时先闪一帧深色。
   无记录或文件损坏时回落深色。 */
export class AppearanceStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "appearance.json");
  }

  get(): AppearanceTheme {
    try {
      if (!fs.existsSync(this.filePath)) return "dark";
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredAppearanceFile>;
      return stored.theme === "light" || stored.theme === "dark" ? stored.theme : "dark";
    } catch {
      return "dark";
    }
  }

  save(theme: AppearanceTheme): void {
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, theme } satisfies StoredAppearanceFile, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
