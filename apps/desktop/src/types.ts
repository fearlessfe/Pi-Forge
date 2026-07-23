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
  question: string;
  answer: string;
};
