import { useI18n } from "../i18n";
import { PluginsPanel } from "./PluginsPanel";

type PluginCenterViewProps = {
  agentRunning: boolean;
  workspaceCwd?: string;
};

export function PluginCenterView({ agentRunning, workspaceCwd }: PluginCenterViewProps) {
  const { t } = useI18n();

  return (
    <main className="plugin-center-main" aria-label={t("插件中心")}>
      <div className="plugin-center-content">
        <PluginsPanel agentRunning={agentRunning} workspaceCwd={workspaceCwd} />
      </div>
    </main>
  );
}
