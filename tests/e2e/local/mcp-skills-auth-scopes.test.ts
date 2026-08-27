import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { startTestHttpServer } from '../../helpers/test-http-server';

const fixture = (name: string) => resolve(import.meta.dir, '..', '..', 'fixtures', name);
const envReference = (name: string) => `\${${name}}`;

interface FixtureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}

async function runFixture(
  script: string,
  workspace: string,
  home: string,
  env: Record<string, string>,
): Promise<FixtureResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', fixture(script)],
    cwd: workspace,
    env: {
      ...process.env,
      ...(process.platform === 'win32' ? { USERPROFILE: home } : { HOME: home }),
      KITE_CODE_HOME: join(home, '.kite-code'),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  let json: Record<string, unknown> | undefined;
  if (lastLine) {
    try {
      json = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      // Failed fixtures may print only an error stack.
    }
  }
  return { exitCode, stdout, stderr, ...(json ? { json } : {}) };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function authenticatedServer(scope: string) {
  const server = new McpServer({ name: `authenticated-http-${scope}`, version: '1.0.0' });
  server.registerTool(
    'authenticated_echo',
    {
      description: 'Returns data only after HTTP bearer authentication succeeds.',
      inputSchema: { message: z.string() },
      outputSchema: { scope: z.string(), message: z.string(), transport: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({
      content: [{ type: 'text' as const, text: `authenticated:${scope}:${message}` }],
      structuredContent: { scope, message, transport: 'http' },
    }),
  );
  return server;
}

function startAuthenticatedHttpServer(token: string, scope: string) {
  const seenAuthorization: Array<string | null> = [];
  const server = startTestHttpServer({
    fetch: async (request) => {
      const authorization = request.headers.get('authorization');
      seenAuthorization.push(authorization);
      if (authorization !== `Bearer ${token}`) {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
          { status: 401 },
        );
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = authenticatedServer(scope);
      await mcp.connect(transport);
      return transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    seenAuthorization,
    stop: () => server.stop(true),
  };
}

function mcpConfig(
  type: 'http' | 'stdio',
  scope: 'user' | 'project',
  transport: Record<string, unknown>,
) {
  return {
    type,
    ...transport,
    trust: { provenance: scope, allowAnnotations: 'read_only' },
    tools: {
      authenticated_echo: {
        effects: { filesystem: 'none', network: 'read', externalState: 'read' },
        minimumApproval: 'none',
      },
    },
  };
}

function skillDocument(name: string, scope: 'user' | 'project', marker: string) {
  return `---
name: ${name}
version: 1.0.0
description: Read a scope marker through the governed Runtime.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
  properties:
    scope:
      type: string
  required: [scope]
output_schema:
  type: object
  properties:
    scope:
      type: string
    content:
      type: string
  required: [scope, content]
capabilities:
  require: [builtin:read_file]
  deny: []
effects:
  filesystem: read
  network: none
  external_state: none
approval:
  minimum: none
execution:
  timeout_ms: 30000
  max_attempts: 1
verification:
  mode: not_required
recovery:
  retry: never
---

SCOPE_MARKER:${marker}
Read scope.txt and complete the workflow with scope '${scope}'.
`;
}

function writeSkill(root: string, name: string, document: string) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), document);
}

describe('authenticated MCP and scoped Skill E2E', () => {
  test('loads a user-level HTTP MCP, authenticates with a bearer header, and executes it through Runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-mcp-user-e2e-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const token = 'user-http-secret';
    mkdirSync(workspace, { recursive: true });
    const http = startAuthenticatedHttpServer(token, 'user');
    try {
      writeJson(join(home, '.kite-code', 'mcp.json'), {
        mcpServers: {
          user_auth: mcpConfig('http', 'user', {
            url: http.url,
            auth: {
              type: 'credential',
              header: 'Authorization',
              credentialRef: 'user-auth-default',
              scheme: 'Bearer',
            },
          }),
        },
      });
      const result = await runFixture('run-mcp-e2e-client.ts', workspace, home, {
        MCP_HTTP_SOURCE_TOKEN: token,
        MCP_E2E_SECRET: token,
        MCP_E2E_SERVER_NAME: 'user_auth',
        MCP_E2E_EXPECTED_SCOPE: 'user',
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json?.provenance).toBe('user');
      expect(result.json?.eventTypes).toEqual(
        expect.arrayContaining(['capability.bindings_issued', 'tool.finished', 'run.completed']),
      );
      expect(String(result.json?.toolStdout)).toContain('authenticated:user:user');
      expect(http.seenAuthorization.length).toBeGreaterThan(0);
      expect(http.seenAuthorization.every((value) => value === `Bearer ${token}`)).toBe(true);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token);
    } finally {
      http.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('fails closed when an HTTP MCP bearer token is invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-mcp-auth-failure-e2e-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const expectedToken = 'expected-http-secret';
    const wrongToken = 'wrong-http-secret';
    mkdirSync(workspace, { recursive: true });
    const http = startAuthenticatedHttpServer(expectedToken, 'user');
    try {
      writeJson(join(home, '.kite-code', 'mcp.json'), {
        mcpServers: {
          denied_auth: mcpConfig('http', 'user', {
            url: http.url,
            auth: {
              type: 'credential',
              header: 'Authorization',
              credentialRef: 'denied-auth-default',
              scheme: 'Bearer',
            },
          }),
        },
      });
      const result = await runFixture('run-mcp-e2e-client.ts', workspace, home, {
        MCP_HTTP_SOURCE_TOKEN: wrongToken,
        MCP_E2E_SECRET: wrongToken,
        MCP_E2E_SERVER_NAME: 'denied_auth',
        MCP_E2E_EXPECTED_SCOPE: 'user',
      });
      expect(result.exitCode).not.toBe(0);
      expect(http.seenAuthorization).toContain(`Bearer ${wrongToken}`);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(expectedToken);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(wrongToken);
    } finally {
      http.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('project MCP config rejects raw stdio credential env without spawning the server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-mcp-project-e2e-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const token = 'project-stdio-secret';
    mkdirSync(workspace, { recursive: true });
    try {
      writeJson(join(home, '.kite-code', 'mcp.json'), {
        mcpServers: {
          shared_auth: mcpConfig('http', 'user', { url: 'http://127.0.0.1:1/mcp' }),
        },
      });
      writeJson(join(workspace, '.kite-code', 'mcp.json'), {
        mcpServers: {
          shared_auth: mcpConfig('stdio', 'project', {
            command: process.execPath,
            args: [fixture('mcp-auth-stdio-server.ts')],
            env: {
              MCP_AUTH_TOKEN: envReference('MCP_STDIO_SOURCE_TOKEN'),
              MCP_EXPECTED_TOKEN: token,
              MCP_AUTH_SCOPE: 'project',
            },
          }),
        },
      });
      const result = await runFixture('run-mcp-e2e-client.ts', workspace, home, {
        MCP_STDIO_SOURCE_TOKEN: token,
        MCP_E2E_SECRET: token,
        MCP_E2E_SERVER_NAME: 'shared_auth',
        MCP_E2E_EXPECTED_SCOPE: 'project',
        MCP_E2E_APPROVE_PROJECT: '1',
        MCP_E2E_APPROVE_TOOL: '1',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('MCP raw credential material is forbidden');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('does not create a real stdio transport before project approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-mcp-project-pending-e2e-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const marker = join(root, 'stdio-started');
    mkdirSync(workspace, { recursive: true });
    try {
      writeJson(join(workspace, '.kite-code', 'mcp.json'), {
        mcpServers: {
          pending_stdio: mcpConfig('stdio', 'project', {
            command: process.execPath,
            args: [fixture('mcp-auth-stdio-server.ts')],
            env: {
              MCP_AUTH_TOKEN: 'valid',
              MCP_EXPECTED_TOKEN: 'valid',
              MCP_STARTUP_MARKER: marker,
            },
          }),
        },
      });

      const result = await runFixture('run-mcp-startup-probe.ts', workspace, home, {});
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json?.connectable).toEqual([]);
      expect(result.json?.states).toEqual([]);
      expect(result.json?.approvals).toEqual([
        { name: 'pending_stdio', status: 'pending_approval' },
      ]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('does not send an HTTP request before project approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-mcp-project-http-pending-e2e-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const http = startAuthenticatedHttpServer('never-sent', 'project');
    try {
      writeJson(join(workspace, '.kite-code', 'mcp.json'), {
        mcpServers: {
          pending_http: mcpConfig('http', 'project', {
            url: http.url,
            headers: { Authorization: 'Bearer never-sent' },
          }),
        },
      });

      const result = await runFixture('run-mcp-startup-probe.ts', workspace, home, {});
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json?.connectable).toEqual([]);
      expect(http.seenAuthorization).toEqual([]);
    } finally {
      http.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('discovers and executes a user-level Skill from the real user directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-skill-user-e2e-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const skillName = 'scoped-read';
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'scope.txt'), 'user skill content');
    writeSkill(
      join(home, '.kite-code', 'skills'),
      skillName,
      skillDocument(skillName, 'user', 'user-workflow'),
    );
    try {
      const result = await runFixture('run-skill-e2e-client.ts', workspace, home, {
        SKILL_E2E_NAME: skillName,
        SKILL_E2E_EXPECTED_SCOPE: 'user',
        SKILL_E2E_EXPECTED_MARKER: 'SCOPE_MARKER:user-workflow',
        SKILL_E2E_READ_PATH: 'scope.txt',
        SKILL_E2E_EXPECTED_CONTENT: 'user skill content',
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json?.provenance).toBe('user');
      expect(result.json?.sawExpectedMarker).toBe(true);
      expect(result.json?.frameClosed).toBe(true);
      expect(result.json?.eventTypes).toEqual(
        expect.arrayContaining([
          'skill.activation_started',
          'tool.finished',
          'skill.frame_closed',
          'run.completed',
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('project Skill shadows the user Skill and executes the project workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-skill-project-e2e-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const skillName = 'scoped-read';
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'scope.txt'), 'project skill content');
    writeSkill(
      join(home, '.kite-code', 'skills'),
      skillName,
      skillDocument(skillName, 'user', 'user-shadowed-workflow'),
    );
    writeSkill(
      join(workspace, '.kite-code', 'skills'),
      skillName,
      skillDocument(skillName, 'project', 'project-winning-workflow'),
    );
    try {
      const result = await runFixture('run-skill-e2e-client.ts', workspace, home, {
        SKILL_E2E_NAME: skillName,
        SKILL_E2E_EXPECTED_SCOPE: 'project',
        SKILL_E2E_EXPECTED_MARKER: 'SCOPE_MARKER:project-winning-workflow',
        SKILL_E2E_FORBIDDEN_MARKER: 'SCOPE_MARKER:user-shadowed-workflow',
        SKILL_E2E_READ_PATH: 'scope.txt',
        SKILL_E2E_EXPECTED_CONTENT: 'project skill content',
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json?.provenance).toBe('project');
      expect(result.json?.sawExpectedMarker).toBe(true);
      expect(result.json?.sawForbiddenMarker).toBe(false);
      expect(result.json?.frameClosed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
