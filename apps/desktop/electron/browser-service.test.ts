import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { BrowserArtifactStore } from "./browser-artifact-store.js";
import { BrowserService } from "./browser-service.js";

type MockSession = {
  partition: string;
  clearStorageData: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  setPermissionCheckHandler: ReturnType<typeof vi.fn>;
  setPermissionRequestHandler: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

type MockView = {
  partition: string;
  backgroundColors: string[];
  setBackgroundColor: (color: string) => void;
  setBounds: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  webContents: {
    close: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    getURL: () => string;
    getTitle: () => string;
    isLoading: () => boolean;
    executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>;
    capturePage: ReturnType<typeof vi.fn>;
    navigationHistory: { canGoBack: () => false; canGoForward: () => false };
  };
};

const createdViews: MockView[] = [];
const sessions = new Map<string, MockSession>();

vi.mock("electron", () => ({
  session: {
    fromPartition: (partition: string) => {
      let value = sessions.get(partition);
      if (!value) {
        value = {
          partition,
          clearStorageData: vi.fn(async () => undefined),
          clearCache: vi.fn(async () => undefined),
          closeAllConnections: vi.fn(async () => undefined),
          setPermissionCheckHandler: vi.fn(),
          setPermissionRequestHandler: vi.fn(),
          on: vi.fn(),
        };
        sessions.set(partition, value);
      }
      return value;
    },
  },
  WebContentsView: class {
    partition: string;
    backgroundColors: string[] = [];
    setBounds = vi.fn();
    setVisible = vi.fn();
    private destroyed = false;
    private url = "about:blank";
    webContents = {
      close: vi.fn(() => { this.destroyed = true; }),
      isDestroyed: () => this.destroyed,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async (url: string) => { this.url = url; }),
      getURL: () => this.url,
      getTitle: () => "",
      isLoading: () => false,
      executeJavaScriptInIsolatedWorld: vi.fn(),
      capturePage: vi.fn(async () => ({ toPNG: () => new Uint8Array([1, 2, 3]) })),
      navigationHistory: { canGoBack: () => false as const, canGoForward: () => false as const },
    };
    constructor(options: { webPreferences: { partition: string } }) {
      this.partition = options.webPreferences.partition;
      createdViews.push(this as unknown as MockView);
    }
    setBackgroundColor(color: string): void {
      this.backgroundColors.push(color);
    }
  },
}));

function createService(artifactStore?: BrowserArtifactStore) {
  const fakeWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1440, height: 900 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  const service = new BrowserService(() => fakeWindow as unknown as BrowserWindow, "/tmp/pi-browser-test", () => undefined, artifactStore);
  return { service, fakeWindow };
}

beforeEach(() => {
  createdViews.length = 0;
  sessions.clear();
});

describe("BrowserService", () => {
  it("applies the dark token background to newly created views by default", async () => {
    const { service } = createService();
    await service.setVisible(true);
    expect(createdViews.at(-1)?.backgroundColors).toEqual(["#1C1C1E"]);
  });

  it("uses and updates the configured theme", async () => {
    const { service } = createService();
    service.setTheme("light");
    await service.setVisible(true);
    service.setTheme("dark");
    expect(createdViews.at(-1)?.backgroundColors).toEqual(["#F5F5F7", "#1C1C1E"]);
  });

  it("keeps the persistent view while a temporary private partition is active", async () => {
    const { service } = createService();
    await service.setVisible(true);
    const persistentView = createdViews[0];
    await service.navigate("https://persistent.example");

    await service.setMode("private");
    const privateView = createdViews[1];
    expect(persistentView.partition).toBe("persist:pi-desktop-browser");
    expect(privateView.partition).toMatch(/^pi-desktop-private-/);
    expect(service.state().mode).toBe("private");

    await service.setMode("persistent");
    const privateSession = sessions.get(privateView.partition);
    expect(privateView.webContents.close).toHaveBeenCalledOnce();
    expect(privateSession?.clearStorageData).toHaveBeenCalledOnce();
    expect(privateSession?.clearCache).toHaveBeenCalledOnce();
    expect(privateSession?.closeAllConnections).toHaveBeenCalledOnce();
    expect(persistentView.webContents.close).not.toHaveBeenCalled();
    expect(createdViews).toHaveLength(2);
    expect(service.state().url).toBe("https://persistent.example/");
  });

  it("destroys and purges private state when the workbench closes", async () => {
    const { service } = createService();
    await service.setMode("private");
    await service.setVisible(true);
    const privateView = createdViews[0];

    await service.setVisible(false);

    expect(privateView.webContents.close).toHaveBeenCalledOnce();
    expect(sessions.get(privateView.partition)?.closeAllConnections).toHaveBeenCalledOnce();
    expect(service.state()).toMatchObject({ mode: "private", url: "about:blank", visible: false });

    await service.setVisible(true);
    expect(createdViews[1].partition).not.toBe(privateView.partition);
  });

  it("clears only the requested persistent data categories", async () => {
    const { service } = createService();
    await service.clearData({ mode: "persistent", dataTypes: ["cookies", "cache"] });
    const persistentSession = sessions.get("persist:pi-desktop-browser");

    expect(persistentSession?.clearStorageData).toHaveBeenCalledWith({ storages: ["cookies"] });
    expect(persistentSession?.clearCache).toHaveBeenCalledOnce();
    expect(persistentSession?.closeAllConnections).not.toHaveBeenCalled();
  });

  it("recreates the active view to clear local and per-view session storage", async () => {
    const { service } = createService();
    await service.setVisible(true);
    await service.navigate("https://example.com");
    const originalView = createdViews[0];

    await service.clearData({ mode: "persistent", dataTypes: ["storage"] });

    expect(originalView.webContents.close).toHaveBeenCalledOnce();
    expect(sessions.get("persist:pi-desktop-browser")?.clearStorageData).toHaveBeenCalledWith({ storages: ["localstorage"] });
    expect(createdViews).toHaveLength(2);
    expect(createdViews[1].webContents.loadURL).toHaveBeenCalledWith("https://example.com/");
  });

  it("returns screenshot lifecycle metadata from annotations", async () => {
    const screenshot = {
      id: "screenshot-1",
      owner: "agent:conversation-1",
      path: "/tmp/pi-browser-test/pi-browser-annotation-screenshot-1.png",
      createdAt: "2026-08-06T01:00:00.000Z",
      expiresAt: "2026-08-07T01:00:00.000Z",
      ttlMs: 86_400_000,
      byteSize: 3,
    };
    const artifacts = {
      save: vi.fn(async () => screenshot),
      cleanup: vi.fn(),
    } as unknown as BrowserArtifactStore;
    const { service } = createService(artifacts);
    await service.navigate("https://example.com");
    createdViews[0].webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        success: true,
        viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
        elements: [],
      });

    const capture = await service.startAnnotation(undefined, "inspect", undefined, "agent:conversation-1");

    expect(artifacts.save).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "agent:conversation-1");
    expect(capture.result).toMatchObject({ success: true, screenshot, screenshotPath: screenshot.path });
    expect(capture.markdown).toContain(screenshot.path);
  });
});
