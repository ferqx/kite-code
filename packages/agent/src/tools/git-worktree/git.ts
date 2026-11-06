import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  canonicalDirectory,
  exists,
  fail,
  identity,
  type PathIdentity,
  readOrdinaryFile,
  sameIdentity,
  samePath,
  sha256,
  utf8,
  validPath,
} from './paths';
import { limits } from './protocol';

export interface Repository {
  root: string;
  gitDir: string;
  commonDir: string;
  bare: boolean;
  rootIdentity: PathIdentity;
  commonIdentity: PathIdentity;
}
export interface ListedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  isCurrent: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}
export interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutHash?: string;
}
export function nulRecords(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  if (bytes[bytes.length - 1] !== 0)
    fail('worktree_protocol_error', 'Git returned an incomplete NUL-terminated response.');
  return splitNul(bytes).map(utf8);
}
function splitNul(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < bytes.length; index++)
    if (bytes[index] === 0) {
      fields.push(bytes.subarray(offset, index));
      offset = index + 1;
    }
  return fields;
}
export function parseWorktrees(bytes: Buffer, sourceRoot: string): ListedWorktree[] {
  const fields = nulRecords(bytes),
    result: ListedWorktree[] = [];
  let current: Record<string, string | boolean> | undefined;
  const flush = () => {
    if (!current) return;
    if (
      typeof current.worktree !== 'string' ||
      (!current.bare &&
        (typeof current.HEAD !== 'string' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(current.HEAD))) ||
      (current.detached && current.branch) ||
      (!current.bare && !current.detached && typeof current.branch !== 'string')
    )
      fail('worktree_protocol_error', 'Git worktree registration is incomplete or contradictory.');
    validPath(current.worktree);
    if (
      (current.bare !== undefined && current.bare !== true) ||
      (current.detached !== undefined && current.detached !== true) ||
      (current.bare &&
        (current.HEAD !== undefined ||
          current.branch !== undefined ||
          current.detached !== undefined)) ||
      (typeof current.branch === 'string' &&
        (!current.branch.startsWith('refs/heads/') ||
          [...current.branch].some(
            (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
          )))
    )
      fail(
        'worktree_protocol_error',
        'Git worktree flags or branch fields are malformed or contradictory.',
      );
    const item: ListedWorktree = {
      path: current.worktree,
      head: typeof current.HEAD === 'string' ? current.HEAD : null,
      branch: typeof current.branch === 'string' ? current.branch : null,
      detached: current.detached === true,
      bare: current.bare === true,
      isMain: result.length === 0,
      isCurrent: samePath(current.worktree, sourceRoot),
      locked: 'locked' in current,
      lockReason:
        typeof current.locked === 'string' && current.locked !== '' ? current.locked : null,
      prunable: 'prunable' in current,
      pruneReason:
        typeof current.prunable === 'string' && current.prunable !== '' ? current.prunable : null,
    };
    if (result.some((other) => samePath(other.path, item.path)))
      fail('worktree_protocol_error', 'Git returned duplicate worktree registration paths.');
    result.push(item);
    current = undefined;
  };
  for (const field of fields) {
    if (!field) {
      flush();
      continue;
    }
    const space = field.indexOf(' '),
      key = space < 0 ? field : field.slice(0, space),
      value = space < 0 ? true : field.slice(space + 1);
    if (key === 'worktree') {
      if (current)
        fail('worktree_protocol_error', 'A worktree record has no terminating delimiter.');
      current = {};
    }
    if (!current) fail('worktree_protocol_error', 'A worktree field has no registration record.');
    if (!['worktree', 'HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable'].includes(key))
      continue;
    if (key in current)
      fail('worktree_protocol_error', 'Git returned a duplicate worktree registration field.');
    current[key] = value;
  }
  if (current) fail('worktree_protocol_error', 'A worktree record is truncated.');
  if (!result.length) fail('worktree_protocol_error', 'Git returned no worktree registrations.');
  return result;
}

export class Git {
  private readonly env: NodeJS.ProcessEnv;
  readonly path: string;
  readonly hooksPath: string;
  constructor(path: string, expectedSha: string, hooksPath: string) {
    this.path = path;
    this.hooksPath = hooksPath;
    if (!exists(path))
      fail(
        'git_not_found',
        'The trusted Git executable is unavailable; restore the host installation.',
      );
    if (sha256(readOrdinaryFile(path, 512 * 1024 * 1024)) !== expectedSha)
      fail(
        'worktree_asset_changed',
        'The trusted Git executable changed; restore the installation.',
      );
    this.env = {};
    for (const key of [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'TMPDIR',
      'LOCALAPPDATA',
      'APPDATA',
      'XDG_CONFIG_HOME',
      'LANG',
      'LC_ALL',
    ])
      if (process.env[key] !== undefined) this.env[key] = process.env[key];
    Object.assign(this.env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'false',
      GIT_SEQUENCE_EDITOR: 'false',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_COUNT: '0',
    });
  }
  async run(
    cwd: string,
    args: readonly string[],
    options: {
      config?: [string, string][];
      input?: string;
      inputFd?: number;
      outputHash?: { algorithm: 'sha1' | 'sha256'; prefix: string; bytes: bigint };
      allowFailure?: boolean;
      location?: { gitDir: string; workTree: string };
    } = {},
  ): Promise<GitResult> {
    const env = { ...this.env };
    const configuration: [string, string][] = [
      ['core.hooksPath', this.hooksPath],
      ['core.fsmonitor', 'false'],
      ['core.untrackedCache', 'false'],
      ['maintenance.auto', 'false'],
      ['maintenance.autoDetach', 'false'],
      ['gc.auto', '0'],
      ['gc.autoDetach', 'false'],
      ['credential.helper', ''],
      ['core.askPass', ''],
      ['submodule.recurse', 'false'],
      ...(options.config ?? []),
    ];
    env.GIT_CONFIG_COUNT = String(configuration.length);
    configuration.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    const argv = [
      '--no-replace-objects',
      '--no-lazy-fetch',
      ...(options.location
        ? [`--git-dir=${options.location.gitDir}`, `--work-tree=${options.location.workTree}`]
        : []),
      ...args,
    ];
    const result = await new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.path, argv, {
        cwd,
        env,
        detached: false,
        stdio: [options.inputFd ?? 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      const hash = options.outputHash
        ? createHash(options.outputHash.algorithm).update(options.outputHash.prefix)
        : undefined;
      let hashedSize = 0n;
      let outSize = 0,
        errSize = 0,
        overflow = false;
      child.stdout!.on('data', (data: Buffer) => {
        if (hash && options.outputHash) {
          hashedSize += BigInt(data.length);
          if (hashedSize > options.outputHash.bytes) {
            overflow = true;
            child.kill();
          } else hash.update(data);
          return;
        }
        outSize += data.length;
        if (outSize > limits.gitStdoutBytes) {
          overflow = true;
          child.kill();
        } else stdout.push(data);
      });
      child.stderr!.on('data', (data: Buffer) => {
        errSize += data.length;
        if (errSize > limits.gitStderrBytes) {
          overflow = true;
          child.kill();
        } else stderr.push(data);
      });
      child.on('error', reject);
      child.on('close', (code) =>
        overflow
          ? reject(new Error('inspection_limit'))
          : resolve({
              exitCode: code ?? -1,
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              ...(hash && options.outputHash && hashedSize === options.outputHash.bytes
                ? { stdoutHash: hash.digest('hex') }
                : {}),
            }),
      );
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(options.input ?? '');
      }
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return fail('git_not_found', 'The trusted Git executable is unavailable.');
      if (error instanceof Error && error.message === 'inspection_limit')
        return fail('inspection_limit', 'Git output exceeded the complete inspection limit.');
      throw error;
    });
    if (result.exitCode !== 0 && !options.allowFailure)
      fail(
        'git_operation_failed',
        'Git failed; inspect the bounded diagnostic and original operation.',
        { gitExitCode: result.exitCode, diagnostic: utf8(result.stderr).slice(0, 4096) },
      );
    return result;
  }
  async text(
    cwd: string,
    args: readonly string[],
    options: Parameters<Git['run']>[2] = {},
  ): Promise<string> {
    const result = await this.run(cwd, args, options),
      text = utf8(result.stdout);
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }
  async repository(cwd: string): Promise<Repository> {
    const capability = await this.run(cwd, ['--version'], { allowFailure: true });
    if (capability.exitCode !== 0)
      fail(
        'unsupported_git_version',
        'The trusted Git must support --no-lazy-fetch; install a supported Git without removing the safety flags.',
      );
    const probe = await this.run(cwd, ['rev-parse', '--is-bare-repository'], {
      allowFailure: true,
    });
    if (probe.exitCode !== 0)
      fail(
        'not_git_repository',
        'The trusted execution directory is not a readable Git repository.',
      );
    const bareText = utf8(probe.stdout);
    if (!['true\n', 'false\n'].includes(bareText))
      fail('worktree_protocol_error', 'Git returned an invalid repository classification.');
    const bare = bareText === 'true\n';
    const gitDir = canonicalDirectory(
      await this.text(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']),
    );
    const commonDir = canonicalDirectory(
      await this.text(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    const root = bare
      ? gitDir
      : canonicalDirectory(
          await this.text(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel']),
        );
    return {
      root,
      gitDir,
      commonDir,
      bare,
      rootIdentity: identity(root),
      commonIdentity: identity(commonDir),
    };
  }
  async list(repository: Repository): Promise<ListedWorktree[]> {
    const result = await this.run(repository.root, ['worktree', 'list', '--porcelain', '-z']);
    if (result.stderr.length)
      fail(
        'worktree_protocol_error',
        'Git reported an incomplete or anomalous worktree registration read.',
        { diagnostic: utf8(result.stderr).slice(0, 4096) },
      );
    return parseWorktrees(result.stdout, repository.root);
  }
  async configuration(
    cwd: string,
    location?: { gitDir: string; workTree: string },
  ): Promise<[string, string][]> {
    const result = await this.run(cwd, ['config', '--null', '--list'], { location });
    if (result.stderr.length)
      fail(
        'unsupported_repository_configuration',
        'Git configuration could not be read without anomalies.',
        { diagnostic: utf8(result.stderr).slice(0, 4096) },
      );
    const output = result.stdout;
    return nulRecords(output).map((field) => {
      const newline = field.indexOf('\n');
      const key = newline < 0 ? field : field.slice(0, newline),
        value = newline < 0 ? '' : field.slice(newline + 1);
      if (!key || key.includes('\0'))
        fail(
          'unsupported_repository_configuration',
          'Git configuration could not be parsed completely.',
        );
      return [key, value];
    });
  }
  async checkSupported(
    repository: Repository,
    location?: { gitDir: string; workTree: string },
  ): Promise<[string, string][]> {
    if (repository.bare)
      fail(
        'unsupported_repository_configuration',
        'Mutation from a bare repository is unsupported.',
      );
    const cwd = location?.workTree ?? repository.root,
      config = await this.configuration(cwd, location);
    if (
      config.some(
        ([key, value]) =>
          key.toLowerCase() === 'core.worktree' ||
          key.toLowerCase() === 'extensions.partialclone' ||
          (/^remote\..+\.promisor$/i.test(key) &&
            !['false', 'no', '0', 'off'].includes(value.toLowerCase())) ||
          (['core.sparsecheckout', 'core.sparsecheckoutcone'].includes(key.toLowerCase()) &&
            !['false', 'no', '0', 'off'].includes(value.toLowerCase())),
      )
    )
      fail(
        'unsupported_repository_configuration',
        'Mutation requires a full ordinary checkout without core.worktree, partial clone, or sparse checkout.',
      );
    if ((await this.text(cwd, ['rev-parse', '--is-shallow-repository'], { location })) !== 'false')
      fail('unsupported_repository_configuration', 'Shallow repository mutation is unsupported.');
    for (const path of [
      join(repository.commonDir, 'info/grafts'),
      join(repository.commonDir, 'objects/info/alternates'),
    ])
      if (exists(path))
        fail(
          'unsupported_repository_configuration',
          'Grafts and object alternates are unsupported.',
        );
    const head = await this.run(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], {
      location,
      allowFailure: true,
    });
    if (head.exitCode !== 0)
      fail(
        'unsupported_repository_configuration',
        'The source checkout must have a readable committed HEAD.',
      );
    return this.filterOverrides(config);
  }
  filterOverrides(config: [string, string][]): [string, string][] {
    const names = new Set<string>();
    for (const [key] of config) {
      const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
      if (match) names.add(match[1]!);
    }
    if (names.size > 1000)
      fail('inspection_limit', 'Too many filter drivers to disable completely.');
    return [...names].flatMap((name): [string, string][] => [
      [`filter.${name}.clean`, ''],
      [`filter.${name}.smudge`, ''],
      [`filter.${name}.process`, ''],
      [`filter.${name}.required`, 'false'],
    ]);
  }
  async branchAbsent(cwd: string, branch: string): Promise<void> {
    if (!branch || branch.startsWith('refs/') || branch.startsWith('-') || branch.includes('@{'))
      fail('invalid_branch_name', 'Use a literal new local branch short name.');
    const checked = await this.run(cwd, ['check-ref-format', '--branch', branch], {
      allowFailure: true,
    });
    if (
      checked.exitCode !== 0 ||
      utf8(checked.stdout) !== `${branch}\n` ||
      (await this.run(cwd, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true }))
        .exitCode !== 0
    )
      fail('invalid_branch_name', 'The new branch name is not a literal valid local branch.');
    const existing = await this.run(
      cwd,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (existing.exitCode === 0)
      fail('branch_exists', 'The requested branch already exists; choose a new name.');
    if (existing.exitCode !== 1)
      fail('git_operation_failed', 'Existing branch state could not be verified.');
    // show-ref reports a dangling symbolic reference as absent. Git branch creation
    // would follow that reference and mutate a different, unrequested branch.
    const symbolic = await this.run(
      cwd,
      ['symbolic-ref', '--no-recurse', '--quiet', `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (symbolic.exitCode === 0)
      fail('branch_exists', 'The requested branch already exists; choose a new name.');
    if (symbolic.exitCode !== 1)
      fail('git_operation_failed', 'Existing symbolic branch state could not be verified.');
  }
  assertRepository(expected: Repository, actual: Repository): void {
    if (
      !samePath(expected.root, actual.root) ||
      !samePath(expected.gitDir, actual.gitDir) ||
      !samePath(expected.commonDir, actual.commonDir) ||
      expected.bare !== actual.bare ||
      !sameIdentity(expected.rootIdentity, actual.rootIdentity, false) ||
      !sameIdentity(expected.commonIdentity, actual.commonIdentity, false)
    )
      fail('target_identity_changed', 'The source repository identity changed since preparation.');
  }
}
