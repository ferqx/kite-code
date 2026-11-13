import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { ConfigurationError } from '@kite-ai/agent/config';

export type ModelKeyringOperation = {
  operation: 'read' | 'create' | 'remove';
  service: string;
  account: string;
  key?: Buffer;
  interactive?: boolean;
};

const errors = [
  'model_credentials_locked',
  'model_credentials_backend_unavailable',
  'credential_already_exists',
  'credential_unavailable',
];
const frameLimit = 96 * 1024;

/** The child has one private request pipe and no business or diagnostic output. */
const childSource = `
const codes = ${JSON.stringify(errors)};
let chunks = [];
let size = 0;
let reply;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > ${frameLimit}) throw Error();
    chunks.push(chunk);
  }
  const { key, ...input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (key !== undefined) input.key = Buffer.from(key, 'base64');
  const { modelKeyringOperation } = await import(process.argv[1]);
  try {
    const value = await modelKeyringOperation(input);
    reply = { data: value?.toString('base64') ?? null };
    value?.fill(0);
  } finally {
    input.key?.fill(0);
  }
} catch (error) {
  reply = { code: codes.includes(error?.code) ? error.code : 'credential_unavailable' };
}
for (const chunk of chunks) chunk.fill(0);
process.stdout.write(JSON.stringify(reply));
`;

export function linuxModelKeyringEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return {};
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function runModelKeyringChild(
  moduleUrl: string,
  input: ModelKeyringOperation,
): Promise<Buffer | null> {
  const url = new URL(moduleUrl);
  if (url.protocol !== 'file:' || url.search || url.hash)
    throw new ConfigurationError('credential_unavailable');
  const loader = url.pathname.endsWith('.ts')
    ? ['--import', new URL('../../../scripts/development/node-loader.mjs', url).href]
    : [];
  const request = JSON.stringify({ ...input, key: input.key?.toString('base64') });
  if (Buffer.byteLength(request) > frameLimit)
    throw new ConfigurationError('credential_unavailable');
  const value: unknown = await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        ...loader,
        '--no-global-search-paths',
        '--input-type=module',
        '--eval',
        childSource,
        url.href,
      ],
      {
        env: { HOME: homedir(), LANG: 'C.UTF-8', ...linuxModelKeyringEnvironment() },
        timeout: input.interactive ? 90_000 : 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: frameLimit,
      },
      (error, stdout) => {
        try {
          if (error) throw error;
          resolve(JSON.parse(stdout));
        } catch {
          reject(new ConfigurationError('credential_unavailable'));
        }
      },
    );
    child.stdin?.on('error', () => child.kill('SIGKILL'));
    child.stdin?.end(request);
  });
  if (value && typeof value === 'object' && Object.keys(value).length === 1) {
    if ('code' in value && typeof value.code === 'string' && errors.includes(value.code))
      throw new ConfigurationError(value.code);
    if ('data' in value) {
      if (value.data === null) return null;
      if (typeof value.data === 'string') {
        const bytes = Buffer.from(value.data, 'base64');
        if (bytes.length <= 65536 && bytes.toString('base64') === value.data) return bytes;
      }
    }
  }
  throw new ConfigurationError('credential_unavailable');
}
