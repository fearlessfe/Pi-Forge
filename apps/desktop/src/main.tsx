import { Profiler, StrictMode, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";

type ReactProfileCommit = {
  id: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
};

const performanceWindow = window as Window & { piReactProfile?: ReactProfileCommit[] };
const recordProfile: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  const commits = performanceWindow.piReactProfile ??= [];
  if (commits.length < 256) commits.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
};

function profiled(children: ReactNode): ReactNode {
  if (import.meta.env.VITE_PERFORMANCE_PROFILE !== "1") return children;
  return <Profiler id="PiForge" onRender={recordProfile}>{children}</Profiler>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {profiled(<I18nProvider><App /></I18nProvider>)}
  </StrictMode>,
);
