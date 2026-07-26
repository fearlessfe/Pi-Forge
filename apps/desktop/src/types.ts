import type { AuthPrompt, ConversationActivity, ProviderId, ResponseUsage } from "./contracts.js";

export type Theme = "dark" | "light";

export type AppView = "chat" | "settings";

export type SettingsSection = "models" | "model-metadata" | "plugins" | "skills" | "mcp" | "permissions" | "general" | "appearance";

export type Conversation = {
  id: string;
  title: string;
  subtitle: string;
  updatedAt: string;
  tags: string[];
  archived: boolean;
  searchText: string;
  parentConversationId?: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  conversations: Conversation[];
};

export type AuthFlowState = {
  loginId: string;
  providerId: ProviderId;
  status: "running" | "error";
  message?: string;
  url?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  prompt?: AuthPrompt;
};

export type ChatTurn = {
  id: string;
  sessionEntryId?: string;
  runId?: string;
  question: string;
  answer: string;
  activities: ChatActivity[];
  usage?: ResponseUsage;
  status: "running" | "completed" | "error" | "stopped";
  error?: string;
};

export type ChatActivity = ConversationActivity;
