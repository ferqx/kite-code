import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { type LaunchIdentity, launchIdentity, removeRuntimeTemp } from '../../jobs/launch-identity';

interface Registration {
  secret: string;
  label: string;
  domain: string;
  root: LaunchIdentity;
}
export interface LaunchdControl {
  socket: Socket;
  registration: Registration;
}
const MAX_FRAME = 1024 * 1024;
const xml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function startupDiagnostic(rootPath: string) {
  let fd: number | undefined;
  try {
    fd = openSync(join(rootPath, 'guardian-stderr.log'), 'r');
    const bytes = Buffer.alloc(8192);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function launchctl(args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn('/bin/launchctl', args, {
    env: { PATH: '/usr/bin:/bin' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let overflow = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 256 * 1024) overflow = true;
    else output += chunk;
  });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', () => clearTimeout(timer));
      child.once('close', resolve);
      child.once('error', reject);
    });
    if (overflow) throw Error('launchd_response_overflow');
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}

/** File and socket are in the trusted host's protected private control base. */
export async function connectLaunchdControl(
  path: string,
  kind: 'shell' | 'mcp' = 'shell',
  onConnectionFailure?: (registration: Registration) => Promise<void>,
): Promise<LaunchdControl> {
  if (kind !== 'shell' && kind !== 'mcp') throw Error('launchd_control_invalid');
  const registration = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as Registration;
  if (
    !/^[a-f0-9-]{36}$/.test(registration.secret) ||
    !new RegExp(`^com\\.kitecode\\.${kind}\\.[a-f0-9-]{36}$`).test(registration.label) ||
    registration.domain !== `user/${process.getuid!()}` ||
    registration.root.canonical !== realpathSync.native(path)
  )
    throw Error('launchd_control_invalid');
  const current = launchIdentity(path);
  if (
    current.device !== registration.root.device ||
    current.inode !== registration.root.inode ||
    current.mode !== registration.root.mode
  )
    throw Error('launchd_control_changed');
  if (realpathSync.native(process.cwd()) !== current.canonical)
    throw Error('launchd_control_cwd_changed');
  const socket = createConnection('control.sock');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
  } catch (error) {
    socket.destroy();
    await onConnectionFailure?.(registration);
    throw error;
  }
  // Authentication is independent of the public Job reference/nonce. The secret
  // is never an argv/environment value or business-output frame.
  socket.write(
    `${JSON.stringify({ type: 'guardian', secret: registration.secret, pid: process.pid })}\n`,
  );
  return { socket, registration };
}

export async function removeLaunchdRegistration(registration: Registration): Promise<void> {
  const target = `${registration.domain}/${registration.label}`;
  const removed = await launchctl(['bootout', target]);
  const deadline = Date.now() + 2000;
  let after: Awaited<ReturnType<typeof launchctl>>;
  do {
    after = await launchctl(['print', target]);
    if (after.code === 113) break;
    if (after.code !== 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  // The original label can already be absent, or removal can commit before the
  // bounded launchctl client receives its reply. Its exact postcondition is
  // authoritative. Neither a successful bootout nor this absence proves that
  // the business subtree stopped; that fact comes from the guardian separately.
  if (after.code !== 113)
    throw Object.assign(Error('launchd_cleanup_unconfirmed'), {
      removedCode: removed.code,
      afterCode: after.code,
      afterPid: after.output.match(/^\tpid = (\d+)$/m)?.[1] ?? null,
    });
  removeRuntimeTemp(registration.root);
}

/** Private stdin/stdout broker; it never executes the business command in its own coalition. */
export async function startLaunchdSupervisor(input: {
  frame: Record<string, unknown>;
  controlBase: string;
  kind?: 'shell' | 'mcp';
  includeRegistration?: boolean;
  cancelled?: () => boolean;
  onFrame(frame: Record<string, unknown>): Promise<void>;
}): Promise<{
  stop(): void;
  send(frame: Record<string, unknown>): Promise<void>;
  finished: Promise<void>;
}> {
  if (process.platform !== 'darwin' || !input.controlBase.startsWith('/'))
    throw Error('launchd_supervisor_unsupported');
  const kind = input.kind ?? 'shell';
  if (kind !== 'shell' && kind !== 'mcp') throw Error('launchd_supervisor_unsupported');
  const frameLimit = kind === 'mcp' ? 2 * 1024 * 1024 + 64 * 1024 : MAX_FRAME;
  const rootPath = realpathSync.native(mkdtempSync(join(input.controlBase, `${kind}-`)));
  chmodSync(rootPath, 0o700);
  const registration: Registration = {
    secret: randomUUID(),
    label: `com.kitecode.${kind}.${randomUUID()}`,
    domain: `user/${process.getuid!()}`,
    root: launchIdentity(rootPath),
  };
  const owner = join(rootPath, 'owner.json');
  writeFileSync(owner, JSON.stringify(registration), { mode: 0o600, flag: 'wx' });
  let channel: Socket | undefined;
  let registered = false;
  let businessSent = false;
  let finished = false;
  let terminal: Record<string, unknown> | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Attach an error observer before bootstrap can fail and before awaiting ready.
  void ready.catch(() => {});
  let finishResolve!: () => void;
  let finishReject!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  void completion.catch(() => {});
  const server = createServer((socket) => {
    if (channel) {
      socket.destroy();
      return;
    }
    let authenticated = false;
    let buffer = '';
    let chain = Promise.resolve();
    socket.setEncoding('utf8');
    socket.on('error', (error) => {
      if (!authenticated) readyReject(error);
      else if (!finished) finishReject(error);
    });
    socket.on('end', () => {
      if (!finished) finishReject(Error('launchd_guardian_disconnected'));
    });
    socket.on('close', () => {
      if (!finished) {
        const error = Error('launchd_guardian_disconnected');
        readyReject(error);
        finishReject(error);
      }
    });
    socket.on('data', (chunk: string) => {
      socket.pause();
      buffer += chunk;
      if (Buffer.byteLength(buffer) > frameLimit) {
        socket.destroy(Error('launchd_frame_overflow'));
        return;
      }
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n');
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        chain = chain.then(async () => {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (!authenticated) {
            if (
              frame.type !== 'guardian' ||
              frame.secret !== registration.secret ||
              !Number.isSafeInteger(frame.pid) ||
              Number(frame.pid) <= 1
            )
              throw Error('launchd_guardian_identity_invalid');
            const actual = await launchctl([
              'print',
              `${registration.domain}/${registration.label}`,
            ]);
            const pid = actual.output.match(/^\tpid = (\d+)$/m);
            if (actual.code !== 0 || !pid || Number(pid[1]) !== frame.pid)
              throw Error('launchd_guardian_identity_changed');
            authenticated = true;
            channel = socket;
            readyResolve();
          } else {
            if (frame.nonce !== input.frame.nonce) throw Error('launchd_frame_identity_invalid');
            if (frame.type === 'terminal') {
              terminal = frame;
              finished = true;
              finishResolve();
            } else
              await input.onFrame(
                (kind === 'mcp' || input.includeRegistration) && frame.type === 'ready'
                  ? {
                      ...frame,
                      registration: {
                        label: registration.label,
                        domain: registration.domain,
                        removed: false,
                      },
                    }
                  : frame,
              );
          }
        });
        void chain.catch((error: Error) => {
          readyReject(error);
          finishReject(error);
          socket.destroy();
        });
      }
      void chain.then(
        () => socket.resume(),
        () => {},
      );
    });
  });
  // The broker is a dedicated private process. Relative socket paths avoid the
  // Darwin sockaddr_un length limit for long installed Profile paths.
  process.chdir(rootPath);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen('control.sock', resolve);
  });
  const plist = join(rootPath, 'job.plist');
  const strings = [process.execPath, process.argv[1]!, '--launchd-owned', rootPath];
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>${xml(registration.label)}</string>
<key>ProgramArguments</key><array>${strings.map((value) => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(rootPath)}</string>
<key>StandardErrorPath</key><string>${xml(join(rootPath, 'guardian-stderr.log'))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><false/><key>ProcessType</key><string>Background</string>
<key>LimitLoadToSessionType</key><string>Background</string>
</dict></plist>`,
    { mode: 0o600, flag: 'wx' },
  );
  const timer = setTimeout(() => readyReject(Error('launchd_guardian_start_timeout')), 4000);
  try {
    const bootstrapped = await launchctl(['bootstrap', registration.domain, plist]);
    if (bootstrapped.code !== 0) throw Error('launchd_bootstrap_failed');
    registered = true;
    await ready;
    if (input.cancelled?.()) throw Error('launchd_start_cancelled');
    const send = async (frame: Record<string, unknown>): Promise<void> => {
      if (!frame || Array.isArray(frame) || frame.nonce !== input.frame.nonce)
        throw Error('launchd_frame_identity_invalid');
      const content = JSON.stringify(frame);
      if (Buffer.byteLength(content) > frameLimit) throw Error('launchd_frame_overflow');
      if (finished || !channel?.writable) throw Error('launchd_guardian_disconnected');
      await new Promise<void>((resolve, reject) =>
        channel!.write(`${content}\n`, (error) => (error ? reject(error) : resolve())),
      );
    };
    businessSent = true;
    await send(input.frame);
    const stop = () =>
      channel?.write(`${JSON.stringify({ type: 'cancel', nonce: input.frame.nonce })}\n`);
    return {
      stop,
      send,
      finished: completion.then(
        async () => {
          channel?.end();
          server.close();
          // A terminal frame without a confirmed subtree still remains unknown.
          // Registration removal alone must never be used as its stop evidence.
          try {
            await removeLaunchdRegistration(registration);
          } catch (error) {
            writeFileSync(
              join(rootPath, 'cleanup-failure.json'),
              JSON.stringify({
                code: error instanceof Error ? error.message : 'unknown',
                ...(error instanceof Error ? error : {}),
              }),
              { mode: 0o600 },
            );
            throw error;
          }
          await input.onFrame(
            kind === 'mcp' || input.includeRegistration
              ? {
                  ...terminal!,
                  registrationRemoved: true,
                  registration: {
                    label: registration.label,
                    domain: registration.domain,
                    removed: true,
                  },
                }
              : terminal!,
          );
        },
        async (error) => {
          channel?.end();
          server.close();
          writeFileSync(
            join(rootPath, 'protocol-failure.json'),
            JSON.stringify({ code: error instanceof Error ? error.message : 'unknown' }),
            { mode: 0o600 },
          );
          // A lost guardian supplies no subtree stop proof. Preserve unknown;
          // do not promote launchd's numerical process-group cleanup to one.
          throw error;
        },
      ),
    };
  } catch (error) {
    channel?.end();
    server.close();
    writeFileSync(
      join(
        input.controlBase,
        `${kind}-failure-${registration.label.slice(`com.kitecode.${kind}.`.length)}.json`,
      ),
      JSON.stringify({
        code: error instanceof Error ? error.message : 'unknown',
        guardianStderr: startupDiagnostic(rootPath),
      }),
      { mode: 0o600, flag: 'wx' },
    );
    if (registered && !businessSent) await removeLaunchdRegistration(registration);
    else if (!registered) removeRuntimeTemp(registration.root);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
