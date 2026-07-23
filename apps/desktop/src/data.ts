import type { Conversation, ModelOption, Project } from "./types";

export const regularConversations: Conversation[] = [
  {
    id: "sql-explain",
    title: "解释这段 SQL 查询",
    subtitle: "普通对话",
    updatedAt: "12m",
  },
  {
    id: "api-compare",
    title: "比较两个 API 方案",
    subtitle: "普通对话",
    updatedAt: "1h",
  },
];

export const projects: Project[] = [
  {
    id: "pi-desktop",
    name: "pi-desktop",
    path: "~/work/pi-desktop",
    conversations: [
      {
        id: "approval-flow",
        title: "权限审批交互",
        subtitle: "刚刚更新",
        updatedAt: "now",
      },
      {
        id: "pi-adapter",
        title: "重构 PiAdapter",
        subtitle: "昨天",
        updatedAt: "1d",
      },
      {
        id: "electron-init",
        title: "Electron 初始化",
        subtitle: "7 月 20 日",
        updatedAt: "3d",
      },
    ],
  },
  {
    id: "storefront",
    name: "storefront",
    path: "~/work/storefront",
    conversations: [
      {
        id: "checkout",
        title: "优化结账流程",
        subtitle: "昨天",
        updatedAt: "1d",
      },
    ],
  },
];

export const modelOptions: ModelOption[] = [
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    description: "速度与代码能力均衡，适合日常开发。",
  },
  {
    id: "claude-opus-4",
    name: "Claude Opus 4",
    description: "复杂推理与大型代码库分析。",
  },
  {
    id: "claude-haiku-3-5",
    name: "Claude Haiku 3.5",
    description: "低延迟，适合快速问答与小任务。",
  },
];
