export type WorktreeFailureCategory =
  | 'process_start'
  | 'permission_denied'
  | 'git_command'
  | 'verification';
export interface WorktreeFailure {
  category: WorktreeFailureCategory;
  errno?: string;
  exitCode?: number;
  cleanupUnconfirmed?: true;
}
const errnoNames = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'ENOEXEC',
  'EAGAIN',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'E2BIG',
  'EINVAL',
  'EIO',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EEXIST',
  'ENOTEMPTY',
  'ELOOP',
  'ENAMETOOLONG',
  'ETXTBSY',
  'ECANCELED',
]);
export function validWorktreeFailure(value: unknown): value is WorktreeFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).every((key) =>
      ['category', 'errno', 'exitCode', 'cleanupUnconfirmed'].includes(key),
    ) &&
    typeof item.category === 'string' &&
    ['process_start', 'permission_denied', 'git_command', 'verification'].includes(item.category) &&
    (item.errno === undefined || (typeof item.errno === 'string' && errnoNames.has(item.errno))) &&
    (item.exitCode === undefined ||
      (Number.isInteger(item.exitCode) &&
        Number(item.exitCode) >= -2147483648 &&
        Number(item.exitCode) <= 2147483647 &&
        item.exitCode !== 0)) &&
    (item.cleanupUnconfirmed === undefined || item.cleanupUnconfirmed === true) &&
    (item.category !== 'git_command' || item.exitCode !== undefined)
  );
}
export class WorktreeError extends Error {
  readonly code: string;
  readonly facts: Record<string, unknown>;
  constructor(code: string, message: string, facts: Record<string, unknown> = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.facts = facts;
  }
}
function safeErrno(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && errnoNames.has(code) ? code : undefined;
}
export function processStartFailure(error: unknown): WorktreeError {
  return new WorktreeError(
    'git_process_start_failed',
    'The trusted Git subprocess could not start. This is a host process failure, not a user authorization refusal.',
    {
      failure: {
        category: 'process_start',
        ...(safeErrno(error) ? { errno: safeErrno(error) } : {}),
      },
    },
    error,
  );
}
/** A later child error (for example kill failure) is not evidence that spawn failed. */
export function processEventFailure(error: unknown, started: boolean): WorktreeError {
  return started
    ? new WorktreeError(
        'git_operation_failed',
        'The started Git subprocess could not be observed reliably; preserve its original operation evidence.',
        {
          failure: {
            category: 'verification',
            ...(safeErrno(error) ? { errno: safeErrno(error) } : {}),
          },
        },
        error,
      )
    : processStartFailure(error);
}
export function gitCommandFailure(exitCode: number): WorktreeError {
  return new WorktreeError(
    'git_operation_failed',
    'Git started but its command did not complete successfully. Inspect the repository and the original operation before considering any new intent.',
    { gitExitCode: exitCode, failure: { category: 'git_command', exitCode } },
  );
}
/** Only newly observed errors are classified. Historical receipts are never passed here. */
export function normalizeWorktreeError(error: unknown): WorktreeError {
  if (error instanceof WorktreeError) {
    if (validWorktreeFailure(error.facts.failure)) return error;
    const facts = { ...error.facts };
    delete facts.diagnostic;
    return new WorktreeError(
      error.code,
      error.message,
      { ...facts, failure: { category: 'verification' } },
      error,
    );
  }
  if (error instanceof AggregateError && error.message === 'worktree_output_cleanup_unconfirmed') {
    const primary = normalizeWorktreeError(error.errors[0]);
    return new WorktreeError(
      'worktree_output_cleanup_unconfirmed',
      'Git subprocess resource cleanup could not be confirmed; retain the original operation and its evidence.',
      {
        ...primary.facts,
        failure: { ...(primary.facts.failure as WorktreeFailure), cleanupUnconfirmed: true },
      },
      error,
    );
  }
  const errno = safeErrno(error);
  const syscall = (error as NodeJS.ErrnoException | undefined)?.syscall;
  if (typeof syscall === 'string' && /^(?:uv_)?spawn(?: |$)/.test(syscall))
    return processStartFailure(error);
  if (
    (errno === 'EACCES' || errno === 'EPERM') &&
    typeof syscall === 'string' &&
    [
      'open',
      'mkdir',
      'mkdtemp',
      'unlink',
      'rmdir',
      'scandir',
      'stat',
      'lstat',
      'fstat',
      'read',
      'write',
      'rename',
      'access',
      'realpath',
      'chmod',
      'chown',
      'readlink',
    ].includes(syscall)
  )
    return new WorktreeError(
      'git_permission_denied',
      'The operating system denied filesystem access under the existing execution scope. This does not record a user refusal.',
      { failure: { category: 'permission_denied', errno } },
      error,
    );
  const code =
    error instanceof Error &&
    ['inspection_limit', 'worktree_output_incomplete', 'worktree_output_scope_changed'].includes(
      error.message,
    )
      ? error.message
      : 'git_operation_failed';
  return new WorktreeError(
    code,
    'The worker could not verify the operation; inspect its preserved evidence before any new intent.',
    { failure: { category: 'verification', ...(errno ? { errno } : {}) } },
    error,
  );
}
const categoryGuidance = {
  process_start:
    'The Git subprocess did not start. Check the installed Git runtime and host subprocess support. A spawn error does not mean the user denied authorization or justify requesting broader access.',
  permission_denied:
    'Check the original filesystem scope and target access. Do not infer a user refusal or automatically request broader access.',
  git_command:
    'Git started and returned a nonzero exit code. Check the original exit code and repository state. A nonzero exit alone does not establish permission denial.',
  verification: 'Preserve the original evidence and resolve the reported verification failure.',
} satisfies Record<WorktreeFailureCategory, string>;

const codeGuidance: Readonly<Record<string, string>> = {
  git_operation_failed:
    'No specific failure category was recorded. Do not infer one from stderr or the generic error code.',
  permission_denied:
    'The existing authorization or capability policy denied this request. Do not infer a user refusal or automatically request broader access.',
  temporary_worktree_target:
    'Use an authorized persistent location for a new worktree. Omitting path selects the configured worktree directory.',
  worktree_default_root_unavailable:
    'The configured worktree directory is unavailable. Supply an authorized persistent absolute path if creation is still needed.',
};

const mutationGuidance: Readonly<Record<string, string>> = {
  not_started: 'No mutation was started in this observation.',
  partial: 'The mutation produced partial effects.',
  unknown: 'Mutation effects are unconfirmed.',
  completed: 'The mutation completed before this failure was reported.',
};

export function failureGuidance(
  outcome: 'failed' | 'outcome_unknown' | 'cancelled',
  { code, failure, mutation }: { code?: unknown; failure?: unknown; mutation?: unknown },
): string {
  const classified = validWorktreeFailure(failure) ? failure : undefined;
  const cause = classified
    ? categoryGuidance[classified.category]
    : typeof code === 'string' && Object.hasOwn(codeGuidance, code)
      ? codeGuidance[code]
      : undefined;
  const effectsPossible =
    mutation === 'partial' || mutation === 'unknown' || mutation === 'completed';
  const observeOriginal =
    effectsPossible || outcome === 'outcome_unknown' || classified?.cleanupUnconfirmed;
  const next = observeOriginal
    ? 'Observe only the original operation and Job. Use the returned operation_ref when available.'
    : 'Inspect the reported cause and resolve it before considering any separately authorized new request.';
  return [
    cause,
    classified?.cleanupUnconfirmed ? 'Resource cleanup is unconfirmed.' : undefined,
    typeof mutation === 'string' && Object.hasOwn(mutationGuidance, mutation)
      ? mutationGuidance[mutation]
      : undefined,
    next,
    'Do not replay the original operation by changing its key or arguments, or by using Shell.',
  ]
    .filter(Boolean)
    .join(' ');
}
