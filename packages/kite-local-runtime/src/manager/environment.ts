import { isAbsolute, join, relative, resolve } from 'node:path';

/** Keys explicitly permitted by the current Service process environment baseline. */
export const KITE_SERVICE_ENVIRONMENT_ALLOWLIST = Object.freeze([
  'PATH',
  'SHELL',
  'COMSPEC',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'XDG_CACHE_HOME',
  'BUN_INSTALL_CACHE_DIR',
] as const);

export type KiteServiceEnvironmentKey = (typeof KITE_SERVICE_ENVIRONMENT_ALLOWLIST)[number];

const KITE_SERVICE_FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  'PWD',
  'OLDPWD',
  'INIT_CWD',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'BUN_CONFIG_FILE',
  'BUN_JSC',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
]);

export interface KiteServiceEnvironmentInput {
  /** Canonical user home identity resolved before this function is called. */
  readonly homeRoot: string;
  /** Service state root; neutral cwd is derived beneath this root. */
  readonly stateRoot: string;
  /** Explicit values selected by the App; never defaults to the parent environment. */
  readonly source?: Readonly<Record<string, string | undefined>>;
  /** Canonical OS home selected by a trusted resolver, never copied from source. */
  readonly systemHome?: string;
  /** Canonical Windows user profile selected by a trusted resolver, never copied from source. */
  readonly userProfile?: string;
  /** Fixed build/runtime mode; ambient or Workspace NODE_ENV is ignored. */
  readonly nodeEnvironment?: 'production' | 'development';
  /** Additional exact provider keys resolved by the App (for example OPENAI_API_KEY). */
  readonly allowedKeys?: readonly string[];
  readonly neutralDirectoryName?: string;
}

export interface KiteServiceEnvironment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

function cleanAbsolutePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    !isAbsolute(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new TypeError(`${label} must be an absolute path without control characters.`);
  }
  return resolve(value);
}

function validateEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    throw new TypeError(`Invalid environment key: ${key}`);
  }
}

function validateEnvValue(key: string, value: string): void {
  if ([...value].some((character) => /\p{Cc}/u.test(character))) {
    throw new TypeError(`Environment value for ${key} contains a control character.`);
  }
}

/**
 * Build the child environment explicitly.  In particular, no parent-environment spread is used
 * and cwd is a private neutral directory rather than a requested Workspace.
 */
export function createKiteServiceEnvironment(
  input: KiteServiceEnvironmentInput,
): KiteServiceEnvironment {
  const homeRoot = cleanAbsolutePath(input.homeRoot, 'Service home');
  const stateRoot = cleanAbsolutePath(input.stateRoot, 'Service state root');
  const neutralName = input.neutralDirectoryName ?? 'neutral-cwd';
  if (
    neutralName.length === 0 ||
    neutralName === '.' ||
    neutralName === '..' ||
    neutralName.includes('/') ||
    neutralName.includes('\\') ||
    [...neutralName].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new TypeError('neutralDirectoryName must be one safe directory name.');
  }
  const cwd = join(stateRoot, neutralName);
  const cwdRelative = relative(stateRoot, cwd);
  if (!cwdRelative || cwdRelative.startsWith('..') || isAbsolute(cwdRelative)) {
    throw new TypeError('Neutral cwd must remain beneath the state root.');
  }

  const source = input.source ?? {};
  const allowed = new Set<string>([
    ...KITE_SERVICE_ENVIRONMENT_ALLOWLIST,
    ...(input.allowedKeys ?? []),
  ]);
  for (const key of allowed) {
    validateEnvKey(key);
    if (
      KITE_SERVICE_FORBIDDEN_ENVIRONMENT_KEYS.has(key) ||
      /^KITE_(?:TEST|RUN|FAULT|TUI)_/u.test(key) ||
      key === 'KITE_WORKSPACE_FILESYSTEM_TEST_HOOKS'
    ) {
      throw new TypeError(`Environment key is not allowed for the Service child: ${key}`);
    }
  }

  const env: Record<string, string> = { KITE_CODE_HOME: homeRoot };
  for (const key of allowed) {
    const value = source[key];
    if (value === undefined) continue;
    validateEnvValue(key, value);
    env[key] = value;
  }
  if (input.systemHome !== undefined) {
    env.HOME = cleanAbsolutePath(input.systemHome, 'OS user home');
  }
  if (input.userProfile !== undefined) {
    env.USERPROFILE = cleanAbsolutePath(input.userProfile, 'Windows user profile');
  }
  env.NODE_ENV = input.nodeEnvironment ?? 'production';
  // The service identity always wins over an ambient or workspace-provided value.
  env.KITE_CODE_HOME = homeRoot;
  return Object.freeze({ cwd, env: Object.freeze(env) });
}
