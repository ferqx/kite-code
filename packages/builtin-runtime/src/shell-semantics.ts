import { digestCapabilityBindingValue } from './capability-binding';

export const SHELL_SEMANTICS_REGISTRY_SCHEMA_ = 'kite.shell-semantics-registry.v1' as const;

export type ShellSemanticInspector =
  | 'always_read_only'
  | 'file'
  | 'find'
  | 'git'
  | 'reject_dynamic_execution'
  | 'ripgrep'
  | 'runtime_version'
  | 'sed'
  | 'sort'
  | 'uniq';

export interface ShellProgramSemanticDescriptor {
  readonly programs: readonly string[];
  readonly inspector: ShellSemanticInspector;
}

export interface ShellGitSemanticDescriptor {
  readonly branchListFlags: readonly string[];
  readonly branchIdentityShape: readonly string[];
  readonly remoteListFlags: readonly string[];
  readonly mutationSubcommands: readonly string[];
  readonly remoteMutationSubcommands: readonly string[];
}

export interface ShellSemanticsRegistry {
  readonly schema: typeof SHELL_SEMANTICS_REGISTRY_SCHEMA_;
  readonly revision: 1;
  readonly programs: readonly ShellProgramSemanticDescriptor[];
  readonly git: ShellGitSemanticDescriptor;
}

/**
 * Versioned positive-proof semantics consumed by Shell policy classification.
 * A missing program or invocation shape is unknown, never implicitly safe.
 */
export const SHELL_SEMANTICS_REGISTRY_: ShellSemanticsRegistry = Object.freeze({
  schema: SHELL_SEMANTICS_REGISTRY_SCHEMA_,
  revision: 1,
  programs: Object.freeze([
    Object.freeze({
      inspector: 'always_read_only' as const,
      programs: Object.freeze([
        'basename',
        'cat',
        'cut',
        'df',
        'dirname',
        'du',
        'echo',
        'grep',
        'head',
        'id',
        'jq',
        'ls',
        'md5',
        'md5sum',
        'nl',
        'printenv',
        'ps',
        'pwd',
        'readlink',
        'realpath',
        'sha1sum',
        'sha256sum',
        'shasum',
        'stat',
        'tail',
        'test',
        'tr',
        'uname',
        'wc',
        'whoami',
      ]),
    }),
    Object.freeze({ inspector: 'file' as const, programs: Object.freeze(['file']) }),
    Object.freeze({ inspector: 'find' as const, programs: Object.freeze(['find']) }),
    Object.freeze({ inspector: 'git' as const, programs: Object.freeze(['git']) }),
    Object.freeze({
      inspector: 'reject_dynamic_execution' as const,
      programs: Object.freeze(['awk', 'xargs']),
    }),
    Object.freeze({ inspector: 'ripgrep' as const, programs: Object.freeze(['rg']) }),
    Object.freeze({
      inspector: 'runtime_version' as const,
      programs: Object.freeze(['bun', 'node', 'npm', 'pnpm', 'yarn']),
    }),
    Object.freeze({ inspector: 'sed' as const, programs: Object.freeze(['sed']) }),
    Object.freeze({ inspector: 'sort' as const, programs: Object.freeze(['sort']) }),
    Object.freeze({ inspector: 'uniq' as const, programs: Object.freeze(['uniq']) }),
  ]),
  git: Object.freeze({
    branchListFlags: Object.freeze(['--all', '--list', '--no-color', '--remotes', '-a', '-r']),
    branchIdentityShape: Object.freeze(['--show-current']),
    remoteListFlags: Object.freeze(['--verbose', '-v']),
    mutationSubcommands: Object.freeze([
      'add',
      'branch',
      'checkout',
      'clean',
      'clone',
      'commit',
      'fetch',
      'merge',
      'pull',
      'push',
      'rebase',
      'reset',
      'restore',
      'stash',
      'switch',
      'tag',
    ]),
    remoteMutationSubcommands: Object.freeze([
      'add',
      'prune',
      'remove',
      'rename',
      'set-branches',
      'set-head',
      'set-url',
      'update',
    ]),
  }),
});

export const SHELL_SEMANTICS_REVISION_ = digestCapabilityBindingValue(SHELL_SEMANTICS_REGISTRY_);

const PROGRAM_INSPECTORS_ = new Map<string, ShellSemanticInspector>(
  SHELL_SEMANTICS_REGISTRY_.programs.flatMap((descriptor) =>
    descriptor.programs.map((program) => [program, descriptor.inspector] as const),
  ),
);

export function shellSemanticInspector(program: string): ShellSemanticInspector | undefined {
  return PROGRAM_INSPECTORS_.get(program);
}

export function isDeclaredReadOnlyGitBranch(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return true;
  if (
    arguments_.length === SHELL_SEMANTICS_REGISTRY_.git.branchIdentityShape.length &&
    arguments_.every(
      (argument, index) => argument === SHELL_SEMANTICS_REGISTRY_.git.branchIdentityShape[index],
    )
  ) {
    return true;
  }
  const allowed = new Set(SHELL_SEMANTICS_REGISTRY_.git.branchListFlags);
  return arguments_.every((argument) => allowed.has(argument));
}

export function isDeclaredReadOnlyGitRemote(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return true;
  const allowed = new Set(SHELL_SEMANTICS_REGISTRY_.git.remoteListFlags);
  return arguments_.every((argument) => allowed.has(argument));
}

export function isDeclaredGitMutation(subcommand: string): boolean {
  return SHELL_SEMANTICS_REGISTRY_.git.mutationSubcommands.includes(subcommand);
}

export function isDeclaredGitRemoteMutation(subcommand: string): boolean {
  return SHELL_SEMANTICS_REGISTRY_.git.remoteMutationSubcommands.includes(subcommand);
}
