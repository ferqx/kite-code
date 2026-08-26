import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_ENTRYPOINT = join(REPOSITORY_ROOT, 'apps/kite-cli/src/cli/executable.ts');
const DEADLINE_MS = 7_000;

test('real stdio child keeps JSONL clean, releases EOF locally, and reopens persisted receipts', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-stdio-child-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const checkpointPath = join(root, 'runtime.sqlite');
  const sessionId = 'stdio-child-session';
  const commandId = 'stdio-child-create';
  const secret = 'stdio-child-secret-must-not-escape';
  const children: SpawnedChild[] = [];
  let eofKeepsOwnerAlive = false;

  try {
    writeIsolatedConfig(home, secret);
    mkdirSync(workspace, { recursive: true });

    const first = startChild({ home, workspace, checkpointPath, sessionId });
    children.push(first);
    first.stdin.write(initializeRequest('init').slice(0, 43));
    first.stdin.write(
      `${initializeRequest('init').slice(43)}${pingRequest('ping')}{"body":"${secret}"\n`,
    );

    await expect(first.stdout.response('init')).resolves.toMatchObject({
      result: { protocolVersion: 1, protocolSchema: 'kite.runtime-protocol.v1' },
    });
    await expect(first.stdout.response('ping')).resolves.toMatchObject({
      result: { status: 'ok' },
    });
    await expect(first.stdout.parseError()).resolves.toMatchObject({
      error: { code: -32700, data: { code: 'parse_error' } },
    });

    first.stdin.write(commandRequest('create', createSessionCommand(commandId, sessionId)));
    const created = await first.stdout.response('create');
    expect(created).toMatchObject({
      result: { status: 'applied', commandId, sessionId, revision: 0 },
    });
    first.stdin.write(queryRequest('query', sessionId));
    const queried = await first.stdout.response('query');
    expect(queried).toMatchObject({
      result: { status: 'ok', queryType: 'get_session_projection', session: { sessionId } },
    });
    expect(JSON.stringify(created)).not.toContain(workspace);
    expect(JSON.stringify(queried)).not.toContain(workspace);

    // EOF must only release the carrier connection. The stdio child remains
    // its composition owner until the parent explicitly terminates it.
    first.stdin.end();
    eofKeepsOwnerAlive = await remainsRunning(first.proc, 150);
    if (eofKeepsOwnerAlive) first.proc.kill();
    await expectExit(first, 'owner signal after stdin EOF');
    await first.stdout.done;
    await first.stderr.done;
    first.stdout.assertProtocolOnly();
    expect(first.stderr.text()).not.toContain(secret);

    // Kill a fresh child without using a POSIX process group, then prove a
    // newly spawned child reopens the exact Store/session and replays the
    // persisted receipt instead of creating it again.
    const interrupted = startChild({ home, workspace, checkpointPath, sessionId });
    children.push(interrupted);
    interrupted.stdin.write(initializeRequest('restart-init'));
    await interrupted.stdout.response('restart-init');
    interrupted.stdin.write(queryRequest('restart-query', sessionId));
    await expect(interrupted.stdout.response('restart-query')).resolves.toMatchObject({
      result: { status: 'ok', session: { sessionId } },
    });
    killAbruptly(interrupted.proc);
    await expectExit(interrupted, 'abrupt child termination');
    await interrupted.stdout.done;
    await interrupted.stderr.done;
    interrupted.stdout.assertProtocolOnly();
    expect(interrupted.stderr.text()).not.toContain(secret);

    const restarted = startChild({ home, workspace, checkpointPath, sessionId });
    children.push(restarted);
    restarted.stdin.write(initializeRequest('reconnect-init'));
    await restarted.stdout.response('reconnect-init');
    restarted.stdin.write(queryRequest('reconnect-query', sessionId));
    await expect(restarted.stdout.response('reconnect-query')).resolves.toMatchObject({
      result: { status: 'ok', session: { sessionId } },
    });
    restarted.stdin.write(
      commandRequest('replay-create', createSessionCommand(commandId, sessionId)),
    );
    await expect(restarted.stdout.response('replay-create')).resolves.toMatchObject({
      result: { status: 'idempotent_replay', commandId, sessionId, originalRevision: 0 },
    });
    restarted.stdin.end();
    restarted.proc.kill();
    await expectExit(restarted, 'final owner termination');
    await restarted.stdout.done;
    await restarted.stderr.done;
    restarted.stdout.assertProtocolOnly();
    expect(restarted.stderr.text()).not.toContain(secret);
    expect(eofKeepsOwnerAlive).toBe(true);
  } finally {
    await Promise.all(children.map((child) => stopChild(child)));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

type JsonRpcFrame = Readonly<Record<string, unknown>>;

interface SpawnedChild {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly stdin: ChildInput;
  readonly stdout: JsonlCollector;
  readonly stderr: TextCollector;
}

interface ChildInput {
  write(chunk: string): unknown;
  end(): unknown;
}

function startChild(input: {
  readonly home: string;
  readonly workspace: string;
  readonly checkpointPath: string;
  readonly sessionId: string;
}): SpawnedChild {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      CLI_ENTRYPOINT,
      'server',
      '--stdio',
      '--thread',
      input.sessionId,
      '--workspace',
      input.workspace,
      '--checkpoints',
      input.checkpointPath,
      '--trust-workspace',
      '--no-sandbox',
    ],
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      HOME: input.home,
      KITE_CODE_HOME: input.home,
      XDG_CONFIG_HOME: input.home,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    proc,
    stdin: proc.stdin as ChildInput,
    stdout: new JsonlCollector(proc.stdout),
    stderr: new TextCollector(proc.stderr),
  };
}

function writeIsolatedConfig(home: string, secret: string): void {
  const configPath = join(home, '.kite-code', 'kite-code.jsonc');
  mkdirSync(resolve(configPath, '..'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: {
        'stdio-test': {
          type: 'openai-compatible',
          apiKey: secret,
          baseURL: 'http://127.0.0.1:1/v1',
          model: 'mock-model',
          models: ['mock-model'],
        },
      },
      model: { default: { provider: 'stdio-test', name: 'mock-model' } },
      interactionMode: 'auto',
      sandbox: { enabled: false },
      features: {},
      mcpServers: {},
    }),
  );
  // This test intentionally never sends start_turn, so this unreachable
  // OpenAI-compatible endpoint proves startup/create/query need no network.
}

function initializeRequest(id: string): string {
  return line({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'runtime-stdio-child-test', version: '1', instanceId: `client-${id}` },
    },
  });
}

function pingRequest(id: string): string {
  return line({ jsonrpc: '2.0', id, method: 'server/ping', params: {} });
}

function commandRequest(id: string, command: Readonly<Record<string, unknown>>): string {
  return line({ jsonrpc: '2.0', id, method: 'runtime/command', params: { command } });
}

function queryRequest(id: string, sessionId: string): string {
  return line({
    jsonrpc: '2.0',
    id,
    method: 'runtime/query',
    params: {
      query: { schema: 'kite.runtime-query.v1', type: 'get_session_projection', sessionId },
    },
  });
}

function createSessionCommand(
  commandId: string,
  sessionId: string,
): Readonly<Record<string, unknown>> {
  return {
    schema: 'kite.runtime-command.v1',
    commandId,
    type: 'create_session',
    bootstrapSessionId: sessionId,
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

class TextCollector {
  #text = '';
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.done = this.#collect(stream);
  }

  text(): string {
    return this.#text;
  }

  async #collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        this.#text += decoder.decode(item.value, { stream: true });
      }
      this.#text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
}

class JsonlCollector {
  #lines: string[] = [];
  #frames: JsonRpcFrame[] = [];
  #invalidLines: string[] = [];
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.done = this.#collectJsonl(stream);
  }

  async response(id: string): Promise<JsonRpcFrame> {
    return await eventually(
      () => this.#frames.find((frame) => frame.id === id),
      `response '${id}'`,
    );
  }

  async parseError(): Promise<JsonRpcFrame> {
    return await eventually(
      () => this.#frames.find((frame) => frame.id === null && 'error' in frame),
      'parse error response',
    );
  }

  assertProtocolOnly(): void {
    expect(this.#invalidLines).toEqual([]);
    expect(this.#lines.length).toBeGreaterThan(0);
    for (let index = 0; index < this.#lines.length; index += 1) {
      const line = this.#lines[index]!;
      const frame = this.#frames[index]!;
      expect(frame.jsonrpc).toBe('2.0');
      expect(line).toBe(JSON.stringify(frame));
    }
  }

  async #collectJsonl(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        pending += decoder.decode(item.value, { stream: true });
        pending = this.#consumeCompleteLines(pending);
      }
      pending += decoder.decode();
      if (pending.length > 0) this.#invalidLines.push(pending);
    } finally {
      reader.releaseLock();
    }
  }

  #consumeCompleteLines(text: string): string {
    const lines = text.split('\n');
    const partial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) continue;
      this.#lines.push(line);
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) this.#invalidLines.push(line);
        else this.#frames.push(parsed);
      } catch {
        this.#invalidLines.push(line);
      }
    }
    return partial;
  }
}

function isRecord(value: unknown): value is JsonRpcFrame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function eventually<T>(
  value: () => T | undefined,
  description: string,
  timeoutMs = DEADLINE_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = value();
    if (result !== undefined) return result;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function remainsRunning(
  proc: ReturnType<typeof Bun.spawn>,
  durationMs: number,
): Promise<boolean> {
  const result = await Promise.race([
    proc.exited.then(() => false),
    Bun.sleep(durationMs).then(() => true),
  ]);
  return result;
}

function killAbruptly(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === 'win32') proc.kill();
  else proc.kill('SIGKILL');
}

async function expectExit(child: SpawnedChild, description: string): Promise<void> {
  const exitCode = await Promise.race([
    child.proc.exited,
    Bun.sleep(DEADLINE_MS).then(() => {
      throw new Error(`Timed out waiting for ${description}.`);
    }),
  ]);
  expect(exitCode).toBeNumber();
}

async function stopChild(child: SpawnedChild): Promise<void> {
  try {
    child.stdin.end();
  } catch {
    // The child may have already been killed and its pipe closed.
  }
  try {
    child.proc.kill();
  } catch {
    // Process termination is idempotent for test cleanup.
  }
  await Promise.race([child.proc.exited.catch(() => undefined), Bun.sleep(DEADLINE_MS)]);
  await Promise.all([
    child.stdout.done.catch(() => undefined),
    child.stderr.done.catch(() => undefined),
  ]);
}
