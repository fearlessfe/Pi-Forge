import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { BrowserService } from "./browser-service.js";

type MockView = {
  backgroundColors: string[];
  setBackgroundColor: (color: string) => void;
  setBounds: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  webContents: {
    isDestroyed: () => boolean;
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    getURL: () => string;
    getTitle: () => string;
    isLoading: () => boolean;
    navigationHistory: { canGoBack: () => false; canGoForward: () => false };
  };
};

const createdViews: MockView[] = [];

vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler: () => undefined,
      setPermissionRequestHandler: () => undefined,
      on: () => undefined,
    }),
  },
  WebContentsView: class {
    backgroundColors: string[] = [];
    setBounds = vi.fn();
    setVisible = vi.fn();
    webContents = {
      isDestroyed: () => false,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      getURL: () => "about:blank",
      getTitle: () => "",
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    constructor() {
      createdViews.push(this as unknown as MockView);
    }
    setBackgroundColor(color: string): void {
      this.backgroundColors.push(color);
    }
  },
}));

function createService() {
  const fakeWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1440, height: 900 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  const service = new BrowserService(() => fakeWindow as unknown as BrowserWindow, "/tmp/pi-browser-test", () => undefined);
  return { service };
}

describe("BrowserService.setTheme", () => {
  it("applies the dark token background to newly created views by default", () => {
    const { service } = createService();
    service.setVisible(true);
    expect(createdViews.at(-1)?.backgroundColors).toEqual(["#1C1C1E"]);
  });

  it("uses the light token background when the theme is set before the view exists", () => {
    const { service } = createService();
    service.setTheme("light");
    service.setVisible(true);
    expect(createdViews.at(-1)?.backgroundColors).toEqual(["#F5F5F7"]);
  });

  it("switches the background color of an existing view when the theme changes", () => {
    const { service } = createService();
    service.setVisible(true);
    service.setTheme("light");
    service.setTheme("dark");
    expect(createdViews.at(-1)?.backgroundColors).toEqual(["#1C1C1E", "#F5F5F7", "#1C1C1E"]);
  });
});
