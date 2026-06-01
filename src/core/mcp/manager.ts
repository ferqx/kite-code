// src/core/mcp/manager.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig, McpPrompt, McpResource, McpServerState } from "./types";

const MCP_STARTUP_TIMEOUT = 5000;
const MCP_TOOL_CALL_TIMEOUT = 30_000;
const MCP_RESOURCE_TIMEOUT = 10_000;
const HTTP_MAX_RECONNECT = 5;
const HTTP_RECONNECT_BASE_MS = 1000;

/** Prompt registry entry: maps slash command key to server info */
export interface PromptEntry {
  server: string;
  prompt: McpPrompt;
}

/**
 * Manages multiple MCP server connections, tool aggregation, and prompt registry.
 */
export class McpManager {
  private servers = new Map<string, McpServerState>();
  private promptRegistry = new Map<string, PromptEntry>();

  /** Connect to all configured servers in parallel, non-blocking on individual failures */
  async connectAll(
    servers: Record<string, McpServerConfig>,
  ): Promise<void> {
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connect(name, config)),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        const serverName = entries[i][0];
        console.error(`[MCP] Failed to connect ${serverName}:`, result.reason);
      }
    }
  }

  /** Connect a single MCP server */
  async connect(name: string, config: McpServerConfig): Promise<void> {
    const transport = createTransport(config);
    const client = new Client(
      { name: "openpx", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, { timeout: MCP_STARTUP_TIMEOUT });
    } catch (err) {
      this.servers.set(name, {
        config,
        client,
        tools: [],
        prompts: [],
        resources: [],
        connected: false,
        error: String(err),
      });
      throw err;
    }

    // Fetch tools
    let tools: SdkTool[] = [];
    try {
      const result = await client.listTools();
      tools = result.tools as SdkTool[];
    } catch (err) {
      console.error(`[MCP] Failed to list tools for ${name}:`, err);
    }

    // Fetch prompts (optional)
    let prompts: McpPrompt[] = [];
    try {
      const result = await client.listPrompts();
      prompts = (result.prompts ?? []) as McpPrompt[];
    } catch {
      // prompts are optional
    }

    // Fetch resources (optional)
    let resources: McpResource[] = [];
    try {
      const resourceResult = await client.listResources();
      resources = (resourceResult.resources ?? []) as McpResource[];
    } catch {
      // Resources are optional in MCP
    }

    // Register prompts in the global registry
    for (const prompt of prompts) {
      const key = `mcp__${name}__${prompt.name}`;
      this.promptRegistry.set(key, { server: name, prompt });
    }

    // Set up list-changed notification handlers
    try {
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => {
          try {
            const result = await client.listTools();
            const state = this.servers.get(name);
            if (state) {
              state.tools = result.tools as SdkTool[];
            }
          } catch (err) {
            console.error(
              `[MCP] Failed to refresh tools for ${name}:`,
              err,
            );
          }
        },
      );
    } catch {
      // handler setup best-effort
    }

    try {
      client.setNotificationHandler(
        PromptListChangedNotificationSchema,
        async () => {
          try {
            const result = await client.listPrompts();
            const state = this.servers.get(name);
            if (state) {
              state.prompts = (result.prompts ?? []) as McpPrompt[];
              // Refresh prompt registry for this server
              for (const [key, entry] of this.promptRegistry) {
                if (entry.server === name) {
                  this.promptRegistry.delete(key);
                }
              }
              for (const prompt of state.prompts) {
                const key = `mcp__${name}__${prompt.name}`;
                this.promptRegistry.set(key, { server: name, prompt });
              }
            }
          } catch (err) {
            console.error(
              `[MCP] Failed to refresh prompts for ${name}:`,
              err,
            );
          }
        },
      );
    } catch {
      // handler setup best-effort
    }

    try {
      client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async () => {
          const state = this.servers.get(name);
          if (state) {
            try {
              const result = await client.listResources();
              state.resources = (result.resources ?? []) as McpResource[];
            } catch { /* ignore */ }
          }
        },
      );
    } catch {
      // handler setup best-effort
    }

    this.servers.set(name, {
      config,
      client,
      tools,
      prompts,
      resources,
      connected: true,
    });
  }

  /** Return all tools from all connected servers */
  getAllTools(): Array<{ server: string; tool: SdkTool }> {
    const result: Array<{ server: string; tool: SdkTool }> = [];
    for (const [name, state] of this.servers) {
      if (!state.connected) continue;
      for (const tool of state.tools) {
        result.push({ server: name, tool });
      }
    }
    return result;
  }

  /** Execute an MCP tool on the specified server */
  async callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const state = this.servers.get(server);
    if (!state) {
      throw new Error(`MCP server not found: ${server}`);
    }
    if (!state.connected) {
      throw new Error(`MCP server not connected: ${server}`);
    }
    const client = state.client as Client;
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: state.config.timeout ?? MCP_TOOL_CALL_TIMEOUT },
    );
    // Extract text content from the result
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text);
      return textParts.join("\n");
    }
    return JSON.stringify(result);
  }

  /** 列出指定 server 的所有资源（从缓存） / List resources for a server (from cache) */
  getResources(serverName: string): McpResource[] {
    return this.servers.get(serverName)?.resources ?? [];
  }

  /** 从指定 server 读取资源内容 / Read resource content from a server */
  async readResource(serverName: string, uri: string): Promise<string> {
    if (!serverName || !uri) {
      throw new Error("server and uri are required");
    }
    const state = this.servers.get(serverName);
    if (!state) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }
    if (!state.connected) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }
    const client = state.client as Client;
    const result = await client.readResource(
      { uri },
      { timeout: state.config.timeout ?? MCP_RESOURCE_TIMEOUT },
    );
    // Extract text from resource contents
    if (result.contents && result.contents.length > 0) {
      return result.contents.map((c: { text?: string; blob?: string }) => c.text ?? c.blob ?? "").join("\n");
    }
    return JSON.stringify(result);
  }

  /** Return the prompt registry (slash command key -> server/prompt) */
  getPromptRegistry(): Map<string, PromptEntry> {
    return this.promptRegistry;
  }

  /** Return server states for UI consumption */
  getServerStates(): Map<string, McpServerState> {
    return this.servers;
  }

  /** Disconnect all servers and clean up */
  async disconnectAll(): Promise<void> {
    const names = [...this.servers.keys()];
    await Promise.allSettled(
      names.map(async (name) => {
        const state = this.servers.get(name);
        if (!state) return;
        try {
          const client = state.client as Client;
          await client.close();
        } catch {
          // best-effort close
        }
        this.servers.delete(name);
      }),
    );
    this.promptRegistry.clear();
  }
}

/** Create transport instance from server config */
function createTransport(config: McpServerConfig) {
  if (config.type === "http") {
    const url = new URL(config.url ?? "http://localhost");
    return new StreamableHTTPClientTransport(url, {
      requestInit: config.headers
        ? { headers: config.headers }
        : undefined,
      reconnectionOptions: {
        maxReconnectionDelay:
          HTTP_RECONNECT_BASE_MS * Math.pow(2, HTTP_MAX_RECONNECT),
        initialReconnectionDelay: HTTP_RECONNECT_BASE_MS,
        reconnectionDelayGrowFactor: 2,
        maxRetries: HTTP_MAX_RECONNECT,
      },
    });
  }
  // Default: stdio
  return new StdioClientTransport({
    command: config.command ?? "",
    args: config.args ?? [],
    env: {
      ...process.env,
      OPENPX_PROJECT_DIR: process.cwd(),
      ...config.env,
    } as Record<string, string>,
  });
}
