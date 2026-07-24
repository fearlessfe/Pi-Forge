import type { PiDesktopApi } from "./contracts";

declare global {
  interface Window {
    piDesktop?: PiDesktopApi;
  }
}

export {};
