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
export function failureGuidance(failure: unknown, mutation: unknown): string {
  if (!validWorktreeFailure(failure)) return '';
  const cause = {
    process_start:
      ' Check the installed Git runtime and host subprocess support. This does not mean the user denied authorization.',
    permission_denied:
      ' Check the original filesystem scope and target access. Do not infer a user refusal or automatically request broader access.',
    git_command:
      ' Check the repository state and the original Git exit code; command failure alone does not prove a permission denial.',
    verification: ' Preserve the original evidence and resolve the reported verification failure.',
  }[failure.category];
  return (
    cause +
    (failure.cleanupUnconfirmed ? ' Resource cleanup is unconfirmed.' : '') +
    (mutation === 'partial' || mutation === 'unknown' || mutation === 'completed'
      ? ' Effects may already exist. Observe only the original key and Job; do not repeat creation or removal.'
      : mutation === 'not_started'
        ? ' No mutation was started in this observation. Repairing the cause does not authorize automatic retry.'
        : ' Mutation effects are not established by this error classification; inspect the original operation and Job before considering any further work.') +
    ' Do not change the key or arguments, use Shell as a fallback, or restart an accepted mutation to recover its result.'
  );
}
