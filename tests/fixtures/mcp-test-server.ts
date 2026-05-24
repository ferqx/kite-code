#!/usr/bin/env bun
/**
 * Real MCP test server (stdio) for e2e testing.
 *
 * Provides:
 * - echo       — echoes back a message
 * - add        — adds two numbers
 * - get_info   — returns server metadata
 * - greet prompt   — returns a greeting prompt
 * - info://server resource — static resource
 *
 * Used by e2e tests to verify the full MCP integration path:
 * McpManager → StdioClientTransport → MCP protocol → real tool execution.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "openpx-test-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {}, resources: { subscribe: true } } },
);

// ── Tools ──

server.registerTool(
  "echo",
  {
    description: "Echoes back the input message",
    inputSchema: { message: z.string().describe("The message to echo") },
  },
  async ({ message }) => ({
    content: [{ type: "text" as const, text: `Echo: ${message}` }],
  }),
);

server.registerTool(
  "add",
  {
    description: "Add two numbers together",
    inputSchema: {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
  },
  async ({ a, b }) => ({
    content: [{ type: "text" as const, text: `${a} + ${b} = ${a + b}` }],
  }),
);

server.registerTool(
  "get_info",
  {
    description: "Returns metadata about this MCP server",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ name: "openpx-test-mcp", version: "0.1.0", tools: ["echo", "add", "get_info"] }) }],
  }),
);

// ── Prompts ──

server.registerPrompt(
  "greet",
  {
    description: "Generate a greeting for a user",
    argsSchema: { name: z.string().describe("Name to greet") },
  },
  async ({ name }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: `Please greet ${name} in a friendly manner.` } }],
  }),
);

// ── Resources ──

server.registerResource(
  "server_info",
  "info://server",
  {
    description: "Server metadata resource",
    mimeType: "application/json",
  },
  async () => ({
    contents: [{ uri: "info://server", mimeType: "application/json", text: JSON.stringify({ status: "ok", uptime: "test" }) }],
  }),
);

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
