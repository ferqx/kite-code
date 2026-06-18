export const REAL_TEST_PROVIDER_ENV = 'OPENPX_REAL_PROVIDER';
export const REAL_TEST_MODEL_ENV = 'OPENPX_REAL_MODEL';

export interface RealTestOptions {
  providerName?: string;
  modelName?: string;
  passthroughArgs: string[];
}

export function parseRealTestArgs(argv: string[]): RealTestOptions {
  const options: RealTestOptions = { passthroughArgs: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--provider') {
      options.providerName = readFlagValue(argv, ++i, '--provider');
      continue;
    }
    if (arg.startsWith('--provider=')) {
      options.providerName = readInlineFlagValue(arg, '--provider');
      continue;
    }
    if (arg === '--model') {
      options.modelName = readFlagValue(argv, ++i, '--model');
      continue;
    }
    if (arg.startsWith('--model=')) {
      options.modelName = readInlineFlagValue(arg, '--model');
      continue;
    }
    options.passthroughArgs.push(arg);
  }

  return options;
}

export function buildRealTestCommand(options: RealTestOptions): string[] {
  return [
    'bun',
    'test',
    '--concurrent',
    '--max-concurrency',
    '3',
    './tests/real-agent.real.ts',
    ...options.passthroughArgs,
  ];
}

export function buildRealTestEnv(
  baseEnv: Record<string, string | undefined>,
  options: RealTestOptions,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env[REAL_TEST_PROVIDER_ENV];
  delete env[REAL_TEST_MODEL_ENV];
  if (options.providerName) {
    env[REAL_TEST_PROVIDER_ENV] = options.providerName;
  }
  if (options.modelName) {
    env[REAL_TEST_MODEL_ENV] = options.modelName;
  }
  return env;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readInlineFlagValue(arg: string, flag: string): string {
  const value = arg.slice(`${flag}=`.length);
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
