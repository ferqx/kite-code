import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { openWindowsTestPty } from './pty-windows.ts';

const channel = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sending = Promise.resolve();
function send(value: object) {
  sending = sending.then(async () => {
    if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, 'drain');
  });
  return sending;
}
async function main() {
  const messages = channel[Symbol.asyncIterator]();
  const initial = await messages.next();
  if (initial.done) throw Error('test_windows_pty_config_missing');
  const { command, cwd, env, cols, rows } = JSON.parse(initial.value) as {
    command: [string, ...string[]];
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
  };
  const pty = openWindowsTestPty(command[0], command.slice(1), { cwd, env, cols, rows }, (data) => {
    void send({ data: data.toString('base64') });
  });
  const started = send({ pid: pty.pid });
  let productExit: number | undefined;
  const exited = pty.exited.then((code) => {
    productExit = code;
  });
  await started;
  const reading = (async () => {
    for (;;) {
      const next = await messages.next();
      if (next.done) {
        if (productExit === undefined) pty.kill();
        return;
      }
      const request = JSON.parse(next.value) as Record<string, unknown>;
      if (request.kind === 'write') await pty.write(Buffer.from(String(request.data), 'base64'));
      else if (request.kind === 'resize') pty.resize(Number(request.cols), Number(request.rows));
      else if (request.kind === 'kill') pty.kill();
      else if (request.kind === 'hangup') pty.hangup();
      // ConPTY controls console input in the child and has no POSIX termios.
      // Preserve its existing host-side no-op mode.
      else if (request.kind !== 'raw') throw Error('test_windows_pty_request_invalid');
      await send({ id: request.id });
    }
  })();
  try {
    await Promise.race([reading, exited]);
    await exited;
    await send({ code: productExit });
  } finally {
    channel.close();
    process.stdin.destroy();
  }
}
await main();
