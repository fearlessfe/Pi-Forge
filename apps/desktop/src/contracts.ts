export type ProviderId = "anthropic" | "openai" | "openai-compatible";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelSettings = {
  provider: ProviderId;
  baseUrl: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  hasApiKey: boolean;
  configuredProviders: ProviderId[];
};

export type SaveModelSettings = Omit<ModelSettings, "hasApiKey" | "configuredProviders"> & {
  apiKey?: string;
};

export type QuestionOption = {
  label: string;
  description?: string;
};

export type PiAgentEventType =
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "queue_update"
  | "compaction_start"
  | "compaction_end"
  | "entry_appended"
  | "session_info_changed"
  | "thinking_level_changed"
  | "auto_retry_start"
  | "auto_retry_end"
  | "summarization_retry_scheduled"
  | "summarization_retry_attempt_start"
  | "summarization_retry_finished";

export type AgentTraceEvent = {
  sequence: number;
  timestamp: number;
  eventType: PiAgentEventType;
  payload: unknown;
};

export type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "message.delta"; runId: string; text: string }
  | { type: "thinking.delta"; runId: string; text: string }
  | { type: "tool.started"; runId: string; callId: string; name: string; args: unknown }
  | { type: "tool.updated"; runId: string; callId: string; name: string; output: string }
  | { type: "tool.completed"; runId: string; callId: string; name: string; output: string; isError: boolean }
  | { type: "question.requested"; runId: string; callId: string; question: string; options: QuestionOption[] }
  | { type: "agent.event"; runId: string; event: AgentTraceEvent }
  | { type: "run.completed"; runId: string }
  | { type: "run.stopped"; runId: string }
  | { type: "run.error"; runId: string; message: string };

export type SendPromptInput = {
  prompt: string;
  cwd?: string;
};

export type PiDesktopApi = {
  settings: {
    get(): Promise<ModelSettings>;
    save(settings: SaveModelSettings): Promise<ModelSettings>;
    test(settings: SaveModelSettings): Promise<{ ok: true; response: string }>;
  };
  workspace: {
    choose(): Promise<{ name: string; path: string } | null>;
  };
  agent: {
    send(input: SendPromptInput): Promise<{ runId: string }>;
    abort(): Promise<void>;
    reset(): Promise<void>;
    answerQuestion(callId: string, answer: string): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
};
