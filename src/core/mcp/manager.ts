// src/core/mcp/manager.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createSnapshot,
  descriptorRevision,
  UNKNOWN_EXTERNAL_EFFECTS,
} from '@/core/capabilities/catalog';
import { compileCapabilitySchema } from '@/core/capabilities/schema';
import type {
  CapabilityDescriptor,
  CapabilitySnapshot,
  EffectProfile,
} from '@/protocol/capabilities';
import type { McpPrompt, McpResource, McpServerConfig, McpServerState } from './types';

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
  private snapshot: CapabilitySnapshot = createSnapshot([]);

  /** Connect to all configured servers in parallel, non-blocking on individual failures */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connect(name, config)),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const serverName = entries[i]![0];
        console.error(`[MCP] Failed to connect ${serverName}:`, result.reason);
      }
    }
  }

  /** Connect a single MCP server */
  async connect(name: string, config: McpServerConfig): Promise<void> {
    const transport = createTransport(config);
    const client = new Client({ name: 'kite-code', version: '0.1.0' }, { capabilities: {} });

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
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          const result = await client.listTools();
          const state = this.servers.get(name);
          if (state) {
            state.tools = result.tools as SdkTool[];
            this.refreshSnapshot();
          }
        } catch (err) {
          console.error(`[MCP] Failed to refresh tools for ${name}:`, err);
        }
      });
    } catch {
      // handler setup best-effort
    }

    try {
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
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
            this.refreshSnapshot();
          }
        } catch (err) {
          console.error(`[MCP] Failed to refresh prompts for ${name}:`, err);
        }
      });
    } catch {
      // handler setup best-effort
    }

    try {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        const state = this.servers.get(name);
        if (state) {
          try {
            const result = await client.listResources();
            state.resources = (result.resources ?? []) as McpResource[];
            this.refreshSnapshot();
          } catch {
            /* ignore */
          }
        }
      });
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
    this.refreshSnapshot();
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

  /** Immutable discovery snapshot consumed by the Runtime binding controller. */
  getCapabilitySnapshot(): CapabilitySnapshot {
    return this.snapshot;
  }

  findCapability(capabilityId: string): CapabilityDescriptor | undefined {
    return this.snapshot.descriptors.find((descriptor) => descriptor.capabilityId === capabilityId);
  }

  /** Execute an MCP tool on the specified server */
  async callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const state = this.servers.get(server);
    if (!state) {
      throw new Error(`MCP server not found: ${server}`);
    }
    if (!state.connected) {
      throw new Error(`MCP server not connected: ${server}`);
    }
    const client = state.client as Client;
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: state.config.timeout ?? MCP_TOOL_CALL_TIMEOUT,
    });
    // The SDK's task-enabled overload includes an indirection result. P0 uses
    // synchronous tool calls only; the protocol result is validated by the server.
    return result as CallToolResult;
  }

  /** 列出指定 server 的所有资源（从缓存） / List resources for a server (from cache) */
  getResources(serverName: string): McpResource[] {
    return this.servers.get(serverName)?.resources ?? [];
  }

  /** 从指定 server 读取资源内容 / Read resource content from a server */
  async readResource(serverName: string, uri: string): Promise<string> {
    if (!serverName || !uri) {
      throw new Error('server and uri are required');
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
      return result.contents
        .map((c: { text?: string; blob?: string }) => c.text ?? c.blob ?? '')
        .join('\n');
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
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    const descriptors: CapabilityDescriptor[] = [];
    for (const [serverName, state] of this.servers) {
      if (!state.connected) continue;
      for (const tool of state.tools) {
        descriptors.push(createMcpToolDescriptor(serverName, state.config, tool));
      }
      for (const resource of state.resources) {
        descriptors.push(
          createPassiveDescriptor('mcp_resource', serverName, state.config, resource),
        );
      }
      for (const prompt of state.prompts) {
        descriptors.push(createPassiveDescriptor('mcp_prompt', serverName, state.config, prompt));
      }
    }
    this.snapshot = createSnapshot(descriptors);
  }
}

function createMcpToolDescriptor(
  serverName: string,
  config: McpServerConfig,
  tool: SdkTool,
): CapabilityDescriptor {
  const override = config.tools?.[tool.name];
  const schema = compileCapabilitySchema(tool.inputSchema);
  const declaredEffects = effectsFromAnnotations(config, tool.annotations);
  const effectiveEffects: EffectProfile = {
    ...declaredEffects,
    ...override?.effects,
  };
  const inputSchema = tool.inputSchema as Record<string, unknown>;
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: `mcp:${serverName}/${tool.name}`,
    kind: 'mcp_tool',
    displayName: tool.name,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    provider: { type: 'mcp', id: serverName, provenance: 'remote' },
    inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
    declaredEffects,
    effectiveEffects,
    policy: {
      workspaceTrustRequired: false,
      minimumApproval: override?.minimumApproval ?? 'user',
    },
    availability: schema.ok ? 'available' : 'quarantined',
    diagnostics: schema.ok ? [] : [schema.diagnostic],
  };
  return { ...withoutRevision, revision: descriptorRevision(withoutRevision) };
}

function createPassiveDescriptor(
  kind: 'mcp_resource' | 'mcp_prompt',
  serverName: string,
  _config: McpServerConfig,
  value: { name: string; description?: string; uri?: string },
): CapabilityDescriptor {
  const name = value.name ?? value.uri ?? 'unknown';
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: `mcp:${serverName}/${kind}/${name}`,
    kind,
    displayName: name,
    description: value.description ?? name,
    provider: { type: 'mcp', id: serverName, provenance: 'remote' },
    declaredEffects: UNKNOWN_EXTERNAL_EFFECTS,
    effectiveEffects: UNKNOWN_EXTERNAL_EFFECTS,
    policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
    availability: 'available',
    diagnostics: [],
  };
  return { ...withoutRevision, revision: descriptorRevision(withoutRevision) };
}

function effectsFromAnnotations(
  config: McpServerConfig,
  annotations: SdkTool['annotations'],
): EffectProfile {
  if (config.trust !== 'trusted' || !annotations?.readOnlyHint) return UNKNOWN_EXTERNAL_EFFECTS;
  return { filesystem: 'read', network: 'read', externalState: 'read' };
}

/** Create transport instance from server config */
function createTransport(config: McpServerConfig) {
  if (config.type === 'http') {
    const url = new URL(config.url ?? 'http://localhost');
    return new StreamableHTTPClientTransport(url, {
      requestInit: config.headers ? { headers: config.headers } : undefined,
      reconnectionOptions: {
        maxReconnectionDelay: HTTP_RECONNECT_BASE_MS * 2 ** HTTP_MAX_RECONNECT,
        initialReconnectionDelay: HTTP_RECONNECT_BASE_MS,
        reconnectionDelayGrowFactor: 2,
        maxRetries: HTTP_MAX_RECONNECT,
      },
    });
  }
  // Default: stdio
  return new StdioClientTransport({
    command: config.command ?? '',
    args: config.args ?? [],
    env: {
      ...process.env,
      KITE_CODE_PROJECT_DIR: process.cwd(),
      ...config.env,
    } as Record<string, string>,
  });
}
