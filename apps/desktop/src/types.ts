import type { AgentTraceEvent } from "./contracts";

export type Theme = "dark" | "light";

export type AppView = "chat" | "settings";

export type SettingsSection = "models" | "permissions" | "general" | "appearance";

export type Conversation = {
  id: string;
  title: string;
  subtitle: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  conversations: Conversation[];
};

export type ModelOption = {
  id: string;
  name: string;
  description: string;
};

export type ChatTurn = {
  id: string;
  runId?: string;
  question: string;
  answer: string;
  activities: ChatActivity[];
  trace: AgentTraceEvent[];
  status: "running" | "completed" | "error" | "stopped";
  error?: string;
};

export type ChatActivity =
  | {
      id: string;
      type: "thinking";
      text: string;
    }
  | {
      id: string;
      type: "tool";
      name: string;
      args: unknown;
      output: string;
      status: "running" | "success" | "error";
    }
  | {
      id: string;
      type: "question";
      question: string;
      options: Array<{ label: string; description?: string }>;
      answer?: string;
      status: "pending" | "answered";
    };
