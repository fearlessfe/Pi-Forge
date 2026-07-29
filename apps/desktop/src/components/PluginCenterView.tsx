import { useI18n } from "../i18n";
import { PluginsPanel } from "./PluginsPanel";

type PluginCenterViewProps = {
  agentRunning: boolean;
  workspaceCwd?: string;
};

export function PluginCenterView({ agentRunning, workspaceCwd }: PluginCenterViewProps) {
  const { t } = useI18n();

  return (
    <main className="size-full min-h-0 min-w-0 overflow-auto bg-bg" aria-label={t("插件中心")}>
      {/* 外层负责两侧留白（宽屏 64px），内层限内容最大 940px——padding 与 max-width 不能同层，
          否则 border-box 会把留白计入 940px，内容只剩 812px。 */}
      <div className="px-16 pt-12 pb-18 [@media(max-width:1100px)]:px-10 [@media(max-width:1100px)]:pt-9.5 [@media(max-width:1100px)]:pb-16">
        <div className="mx-auto w-full max-w-[940px]">
          <PluginsPanel agentRunning={agentRunning} workspaceCwd={workspaceCwd} />
        </div>
      </div>
    </main>
  );
}
