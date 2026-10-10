import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FRAME = 2 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
let nonce = '';
let sendQueue = Promise.resolve();
function send(value: Record<string, unknown>) {
  const line = `${JSON.stringify({ nonce, ...value })}\n`;
  if (Buffer.byteLength(line) > MAX_FRAME) throw Error('tui_pty_frame_too_large');
  sendQueue = sendQueue.then(async () => {
    if (!process.stdout.write(line)) await once(process.stdout, 'drain');
  });
  void sendQueue.catch(() => {});
  return sendQueue;
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw Error('tui_pty_frame_invalid');
}
async function* lines() {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) throw Error('tui_pty_frame_too_large');
      yield JSON.parse(line) as unknown;
      end = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) throw Error('tui_pty_frame_too_large');
  }
  buffer += decoder.decode();
  if (buffer) throw Error('tui_pty_incomplete_frame');
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('tui_pty_platform_unsupported');
  const input = lines();
  const first = await input.next();
  if (first.done) throw Error('tui_pty_init_missing');
  const config = first.value;
  exact(config, ['type', 'nonce', 'launcher', 'argv', 'cwd', 'env', 'deadline']);
  if (
    config.type !== 'start' ||
    typeof config.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(config.nonce) ||
    typeof config.launcher !== 'string' ||
    typeof config.cwd !== 'string' ||
    !Array.isArray(config.argv) ||
    !config.argv.every((arg) => typeof arg === 'string') ||
    !config.env ||
    typeof config.env !== 'object' ||
    Array.isArray(config.env) ||
    !Object.values(config.env).every((value) => typeof value === 'string') ||
    typeof config.deadline !== 'number' ||
    !Number.isFinite(config.deadline) ||
    config.deadline <= Date.now() ||
    config.deadline > Date.now() + 30000
  )
    throw Error('tui_pty_init_invalid');
  nonce = config.nonce;
  const deadline = config.deadline;
  let sequence = 0,
    outputBytes = 0,
    ready = false,
    eof = false;
  const initial: Uint8Array[] = [];
  let resolveEOF!: (code: number) => void;
  const ptyEOF = new Promise<number>((resolve) => {
    resolveEOF = resolve;
  });
  const emitOutput = (bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const part = bytes.subarray(offset, offset + 32768);
      outputBytes += part.length;
      void send({
        type: 'output',
        sequence: sequence++,
        data: Buffer.from(part).toString('base64'),
      });
    }
  };
  const product = Bun.spawn({
    cmd: [config.launcher, ...(config.argv as string[])],
    cwd: config.cwd,
    env: config.env as Record<string, string>,
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, bytes) {
        if (eof) throw Error('tui_pty_output_after_eof');
        if (ready) emitOutput(bytes);
        else initial.push(bytes.slice());
      },
      exit(_terminal, code) {
        eof = true;
        resolveEOF(code);
      },
    },
  });
  await send({ type: 'ready', productPid: product.pid });
  ready = true;
  for (const bytes of initial) emitOutput(bytes);
  const completion = (async () => {
    const [productExitCode, ptyExitCode] = await Promise.all([product.exited, ptyEOF]);
    await sendQueue;
    await send({ type: 'terminal', sequence, productExitCode, ptyExitCode, outputBytes });
    if (productExitCode !== 0 || ptyExitCode !== 0) throw Error('tui_pty_unsuccessful_exit');
    product.terminal?.close();
  })();
  void completion.catch(() => {});
  const commands = (async () => {
    for await (const command of input) {
      exact(command, ['type', 'nonce', 'id', 'data']);
      if (
        command.type !== 'write' ||
        command.nonce !== nonce ||
        typeof command.id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(command.id) ||
        typeof command.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.data)
      )
        throw Error('tui_pty_write_invalid');
      if (Date.now() >= deadline || eof) throw Error('tui_pty_write_closed');
      const bytes = Buffer.from(command.data, 'base64');
      if (!bytes.length || bytes.length > 65536) throw Error('tui_pty_write_invalid');
      if (product.terminal?.write(bytes) !== bytes.length) throw Error('tui_pty_write_unaccepted');
      await send({ type: 'written', id: command.id });
    }
    throw Error('tui_pty_parent_eof');
  })();
  void commands.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      commands,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('tui_pty_driver_deadline')), deadline - Date.now());
      }),
    ]);
  } finally {
    clearTimeout(timer);
    process.stdin.destroy();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    try {
      await send({
        type: 'error',
        code: error instanceof Error ? error.message : 'tui_pty_driver_failed',
      });
    } catch {}
    process.exitCode = 1;
  }
}
