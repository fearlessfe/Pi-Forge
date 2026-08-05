import { randomUUID } from "node:crypto";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { BrowserAnnotationCapture, ResolvePlanReviewInput, SaveModelSettings } from "../src/contracts.js";
import { AgentService, type AgentRuntimeConfig, type PromptExtras } from "./agent-service.js";
import { CapabilityStore } from "./capability-store.js";
import { scopeProjectResources } from "./conversation-resource-scope.js";
import { ModelMetadataStore } from "./model-metadata-store.js";
import { PermissionStore } from "./permission-store.js";
import { PluginSecurityStore } from "./plugin-security-store.js";
import { ResourceStore } from "./resource-store.js";
import { WorkspaceCommandSandbox } from "./workspace-command-sandbox.js";
import type { McpContextResource, McpToolDescriptor } from "./mcp-service.js";
import {
  agentRuntimeProtocolVersion,
  type AgentRuntimeInit,
  type HostRequest,
  type HostResponse,
  type ParentToRuntimeMessage,
  type RuntimeRequest,
  type RuntimeExecutionProfile,
  type RuntimeResponse,
  type RuntimeToParentMessage,
} from "./agent-runtime-protocol.js";

type PendingHostRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};

function send(message: RuntimeToParentMessage): void {
  if (!process.send) throw new Error("Runtime IPC channel is unavailable.");
  process.send(message);
}

function failure(error: unknown): { message: string; stack?: string } {
  return error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
}

class HostRpc {
  private readonly pending = new Map<string, PendingHostRequest>();

  request<T>(method: HostRequest["method"], ...args: unknown[]): Promise<T> {
    return this.requestWithSignal(method, undefined, ...args);
  }

  requestWithSignal<T>(method: HostRequest["method"], signal: AbortSignal | undefined, ...args: unknown[]): Promise<T> {
    const id = randomUUID();
    send({ kind: "host.request", id, method, args });
    const abort = () => send({ kind: "host.cancel", id });
    signal?.addEventListener("abort", abort, { once: true });
    return new Promise<T>((resolve, reject) => this.pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      cleanup: () => signal?.removeEventListener("abort", abort),
    }));
  }

  respond(message: HostResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Runtime host disconnected."));
    }
    this.pending.clear();
  }
}

class HostCredentialStore implements CredentialStore {
  constructor(private readonly host: HostRpc) {}

  read(providerId: string): Promise<Credential | undefined> {
    return this.host.request("credential.read", providerId);
  }

  list(): Promise<readonly CredentialInfo[]> {
    return this.host.request("credential.list");
  }

  async modify(providerId: string, update: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await update(current);
    if (next === undefined) return current;
    await this.host.request("credential.write", providerId, next);
    return next;
  }

  delete(providerId: string): Promise<void> {
    return this.host.request("credential.delete", providerId);
  }
}

class RuntimeSettings {
  constructor(private value: AgentRuntimeConfig) {}

  update(value: AgentRuntimeConfig): void {
    this.value = { ...value };
  }

  resolve(input?: SaveModelSettings): AgentRuntimeConfig {
    if (!input) return { ...this.value };
    const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("API 地址仅支持 HTTP 或 HTTPS。");
    }
    return {
      provider: input.provider.trim(),
      baseUrl,
      modelId: input.modelId.trim(),
      thinkingLevel: input.thinkingLevel,
      apiKey: input.apiKey?.trim() || undefined,
    };
  }
}

const host = new HostRpc();
let agent: AgentService | undefined;
let runtimeSettings: RuntimeSettings | undefined;

class ConversationResourceStore extends ResourceStore {
  private selection: Pick<RuntimeExecutionProfile, "resourceSelectionMode" | "selectedSkills" | "selectedMcpServers"> = {
    resourceSelectionMode: "inherit",
    selectedSkills: [],
    selectedMcpServers: [],
  };

  update(selection: Pick<RuntimeExecutionProfile, "resourceSelectionMode" | "selectedSkills" | "selectedMcpServers">): void {
    this.selection = {
      resourceSelectionMode: selection.resourceSelectionMode,
      selectedSkills: [...selection.selectedSkills],
      selectedMcpServers: [...selection.selectedMcpServers],
    };
  }

  override getProjectSettings(cwd: string) {
    const base = super.getProjectSettings(cwd);
    return scopeProjectResources(base, this.selection);
  }
}

let conversationResources: ConversationResourceStore | undefined;

function initialize(input: AgentRuntimeInit): void {
  if (input.protocolVersion !== agentRuntimeProtocolVersion) {
    throw new Error(`Unsupported runtime protocol ${input.protocolVersion}.`);
  }
  if (agent) throw new Error("Runtime was already initialized.");
  runtimeSettings = new RuntimeSettings(input.modelSettings);
  const capabilities = new CapabilityStore(input.userDataPath);
  const permissions = new PermissionStore(input.userDataPath);
  const resources = new ConversationResourceStore(input.userDataPath);
  resources.update(input.resourceProfile ?? { resourceSelectionMode: "inherit", selectedSkills: [], selectedMcpServers: [] });
  conversationResources = resources;
  const pluginSecurity = new PluginSecurityStore(input.userDataPath);
  const credentials = new HostCredentialStore(host);
  const mcp = {
    tools: (cwd?: string) => host.request<McpToolDescriptor[]>("mcp.tools", cwd),
    contextInventory: (cwd?: string) => host.request<McpContextResource[]>("mcp.contextInventory", cwd),
    callTool: (descriptor: McpToolDescriptor, args: Record<string, unknown>, signal?: AbortSignal) => (
      host.requestWithSignal<{ text: string; details: unknown }>("mcp.callTool", signal, descriptor, args)
    ),
  };
  const browser = {
    startAnnotation: (url?: string, prompt?: string, signal?: AbortSignal): Promise<BrowserAnnotationCapture> => (
      host.requestWithSignal("browser.startAnnotation", signal, url, prompt)
    ),
  };
  agent = new AgentService(
    runtimeSettings,
    input.agentDir,
    input.fallbackCwd,
    (event) => send({ kind: "runtime.event", event }),
    credentials,
    capabilities,
    input.sessionDir,
    permissions,
    new WorkspaceCommandSandbox(),
    new ModelMetadataStore(input.userDataPath),
    resources,
    mcp,
    pluginSecurity,
    browser,
  );
  send({ kind: "runtime.ready", protocolVersion: agentRuntimeProtocolVersion, pid: process.pid });
}

async function invoke(request: RuntimeRequest): Promise<unknown> {
  if (!agent || !runtimeSettings) throw new Error("Runtime is not initialized.");
  const args = request.args;
  switch (request.method) {
    case "getModelCatalog": return agent.getModelCatalog(args[0] as boolean | undefined);
    case "discoverModels": return agent.discoverModels(args[0] as SaveModelSettings);
    case "send": return agent.send(args[0] as string, args[1] as string | undefined, args[2] as string | undefined, args[3] as PromptExtras | undefined);
    case "executeExtensionCommand": return agent.executeExtensionCommand(args[0] as string, args[1] as string | undefined, args[2] as string | undefined);
    case "listConversations": return agent.listConversations();
    case "listConversationPage": return agent.listConversationPage(args[0] as import("../src/contracts.js").ConversationListQuery | undefined);
    case "loadConversation": return agent.loadConversation(args[0] as string);
    case "forkConversation": return agent.forkConversation(args[0] as string, args[1] as string | undefined);
    case "exportConversation": return agent.exportConversation(args[0] as string, args[1] as "markdown" | "json");
    case "setConversationArchived": return agent.setConversationArchived(args[0] as string, args[1] as boolean);
    case "setConversationTags": return agent.setConversationTags(args[0] as string, args[1] as string[]);
    case "renameConversation": return agent.renameConversation(args[0] as string, args[1] as string);
    case "deleteConversation": return agent.deleteConversation(args[0] as string);
    case "abort": return agent.abort();
    case "queueMessage": return agent.queueMessage(args[0] as string, args[1] as "steer" | "followUp", args[2] as PromptExtras | undefined);
    case "clearQueue": return agent.clearQueue();
    case "listChanges": return agent.listChanges(args[0] as string | undefined);
    case "changePath": return agent.changePath(args[0] as string);
    case "acceptChanges": return agent.acceptChanges(args[0] as string[] | undefined);
    case "revertChanges": return agent.revertChanges(args[0] as string[] | undefined);
    case "getPermissionRuntime": return agent.getPermissionRuntime();
    case "getResourceInventory": return agent.getResourceInventory(args[0] as string | undefined);
    case "getContextBudget": return agent.getContextBudget(args[0] as string | undefined);
    case "reloadPackages": return agent.reloadPackages();
    case "refreshCapabilities": return agent.refreshCapabilities();
    case "getPluginRuntime": return agent.getPluginRuntime();
    case "answerQuestion": return agent.answerQuestion(args[0] as string, args[1] as string);
    case "listPlanReviews": return agent.listPlanReviews(args[0] as string | undefined);
    case "resolvePlanReview": return agent.resolvePlanReview(args[0] as ResolvePlanReviewInput);
    case "reset": return agent.reset();
    case "testConfiguration": return agent.testConfiguration(args[0] as SaveModelSettings);
    case "updateConfiguration": {
      agent.reset();
      const profile = args[0] as RuntimeExecutionProfile;
      runtimeSettings.update(profile.modelSettings);
      conversationResources?.update(profile);
      return undefined;
    }
  }
}

async function handleRequest(request: RuntimeRequest): Promise<void> {
  let response: RuntimeResponse;
  try {
    response = { kind: "runtime.response", id: request.id, result: await invoke(request) };
  } catch (error) {
    response = { kind: "runtime.response", id: request.id, error: failure(error) };
  }
  send(response);
}

process.on("message", (message: ParentToRuntimeMessage) => {
  if (!message || typeof message !== "object") return;
  if (message.kind === "runtime.init") {
    try {
      initialize(message.value);
    } catch (error) {
      process.stderr.write(`${failure(error).stack ?? failure(error).message}\n`);
      process.exitCode = 1;
    }
  } else if (message.kind === "runtime.ping") {
    send({ kind: "runtime.pong", id: message.id });
  } else if (message.kind === "runtime.request") {
    void handleRequest(message);
  } else if (message.kind === "host.response") {
    host.respond(message);
  }
});

process.on("disconnect", () => {
  agent?.dispose();
  host.dispose();
  process.exit(0);
});
