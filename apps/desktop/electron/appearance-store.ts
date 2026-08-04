import fs from "node:fs";
import path from "node:path";
import type { AppearancePreference } from "../src/contracts.js";

type StoredAppearanceFile = { version: 1; theme: AppearancePreference };

/* 最近一次界面主题的轻量持久化（docs-internal/design-refresh-apple.md 3.6）：
   createWindow() 据此决定初始背景色，避免浅色用户启动时先闪一帧深色。
   无记录时跟随系统，文件损坏时也安全回落系统偏好。 */
export class AppearanceStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "appearance.json");
  }

  get(): AppearancePreference {
    try {
      if (!fs.existsSync(this.filePath)) return "system";
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredAppearanceFile>;
      return stored.theme === "light" || stored.theme === "dark" || stored.theme === "system" ? stored.theme : "system";
    } catch {
      return "system";
    }
  }

  save(theme: AppearancePreference): void {
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, theme } satisfies StoredAppearanceFile, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
