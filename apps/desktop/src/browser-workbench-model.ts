import type { BrowserClearDataInput, BrowserDataType, BrowserMode, BrowserState } from "./contracts";

export const initialBrowserState: BrowserState = {
  url: "about:blank",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  visible: false,
  annotating: false,
  mode: "persistent",
};

export function nextBrowserMode(mode: BrowserMode): BrowserMode {
  return mode === "persistent" ? "private" : "persistent";
}

export function browserClearDataInput(mode: BrowserMode, dataType: BrowserDataType): BrowserClearDataInput {
  return { mode, dataTypes: [dataType] };
}

export function browserModeDescription(mode: BrowserMode): "持久模式 · Cookie 与站点数据保留" | "隐私模式 · 关闭或切换后自动清除" {
  return mode === "persistent"
    ? "持久模式 · Cookie 与站点数据保留"
    : "隐私模式 · 关闭或切换后自动清除";
}
