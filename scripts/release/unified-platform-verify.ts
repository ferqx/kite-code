import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
export function verifyUnifiedPlatformReport(value: unknown, mode: 'diagnostic' | 'formal') {
  const errors: string[] = [];
  if (!object(value)) return ['platform_report_structure_invalid'];
  if (value.effectfulQualified !== false || value.productionQualified !== false)
    errors.push('unsupported_production_claim');
  if (mode === 'formal') errors.push('default_effectful_platform_not_qualified');
  if (
    value.version !== 1 ||
    !['darwin', 'linux', 'win32'].includes(String(value.platform)) ||
    !['arm64', 'x64'].includes(String(value.arch)) ||
    !hash(value.sourceScriptSha256) ||
    !hash(value.helperSourceSha256) ||
    !hash(value.digest)
  )
    errors.push('platform_report_structure_invalid');
  const { digest, ...body } = value;
  if (digest !== createHash('sha256').update(JSON.stringify(body)).digest('hex'))
    errors.push('platform_report_digest_mismatch');
  if (value.status !== 'passed' || value.cleanup !== 'confirmed')
    return [...errors, 'platform_diagnostic_not_passed'];
  if (
    !closed(value, [
      'version',
      'effectfulQualified',
      'productionQualified',
      'platform',
      'arch',
      'sourceScriptSha256',
      'helperSourceSha256',
      'github',
      'missing',
      'status',
      'candidate',
      'helperSha256',
      'evidence',
      'leases',
      'cleanup',
      'digest',
    ])
  )
    errors.push('platform_report_fields_invalid');
  if (
    !Array.isArray(value.missing) ||
    JSON.stringify(value.missing) !==
      JSON.stringify([
        'default_shell_not_delivered',
        'cross_platform_confinement_not_qualified',
        'native_fork_network_resource_limits_not_qualified',
      ])
  )
    errors.push('platform_missing_boundary_invalid');
  if (
    !closed(value.github, [
      'repository',
      'commit',
      'ref',
      'workflow',
      'workflowRef',
      'workflowSha',
      'runId',
      'runAttempt',
    ]) ||
    Object.values(value.github).some((item) => item !== null && !text(item))
  )
    errors.push('platform_github_binding_invalid');
  const candidate = value.candidate,
    evidence = value.evidence;
  if (
    !closed(candidate, ['digest', 'source', 'sqlite', 'runtimeSha256', 'relocated']) ||
    !hash(candidate.digest) ||
    !hash(candidate.runtimeSha256) ||
    candidate.relocated !== true ||
    !closed(candidate.source, ['commit', 'dirty']) ||
    typeof candidate.source.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(candidate.source.commit) ||
    typeof candidate.source.dirty !== 'boolean' ||
    !closed(candidate.sqlite, ['driver', 'linkage', 'version', 'sourceId', 'manifestSha256']) ||
    candidate.sqlite.driver !== 'bun:sqlite' ||
    !['builtin', 'dynamic'].includes(String(candidate.sqlite.linkage)) ||
    !text(candidate.sqlite.version) ||
    !text(candidate.sqlite.sourceId) ||
    !hash(candidate.sqlite.manifestSha256)
  )
    errors.push('platform_candidate_invalid');
  if (
    !hash(value.helperSha256) ||
    !closed(evidence, [
      'status',
      'pid',
      'servicePid',
      'runtimeVersion',
      'storeId',
      'sessionId',
      'providerCalls',
      'cursor',
      'files',
      'runtimeAssets',
      'shell',
      'sqlite',
      'cleanup',
    ])
  )
    return [...errors, 'platform_cases_invalid'];
  if (
    evidence.status !== 'passed' ||
    evidence.cleanup !== 'confirmed' ||
    !Number.isSafeInteger(evidence.pid) ||
    Number(evidence.pid) < 1 ||
    !Number.isSafeInteger(evidence.servicePid) ||
    Number(evidence.servicePid) < 1 ||
    evidence.servicePid === evidence.pid ||
    !text(evidence.runtimeVersion) ||
    !text(evidence.storeId) ||
    evidence.sessionId !== 's' ||
    evidence.providerCalls !== 5 ||
    typeof evidence.cursor !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(evidence.cursor)
  )
    errors.push('platform_cases_invalid');
  const files = evidence.files,
    assets = evidence.runtimeAssets,
    shell = evidence.shell,
    sqlite = evidence.sqlite;
  if (
    !closed(files, ['status', 'runId', 'writeExecutionId', 'readExecutionId', 'bodySha256']) ||
    files.status !== 'passed' ||
    !text(files.runId) ||
    !text(files.writeExecutionId) ||
    !text(files.readExecutionId) ||
    !hash(files.bodySha256)
  )
    errors.push('platform_files_case_invalid');
  if (
    !closed(assets, ['status', 'readExecutionId', 'writeExecutionId', 'unchangedSha256']) ||
    assets.status !== 'passed' ||
    !text(assets.readExecutionId) ||
    !text(assets.writeExecutionId) ||
    !hash(assets.unchangedSha256)
  )
    errors.push('platform_assets_case_invalid');
  if (
    !closed(shell, ['status', 'commandId', 'reason', 'providerCalls', 'jobs']) ||
    shell.status !== 'unavailable' ||
    shell.commandId !== 'no-default-shell' ||
    shell.reason !== 'shell_unavailable' ||
    shell.providerCalls !== 0 ||
    shell.jobs !== 0
  )
    errors.push('platform_shell_case_invalid');
  if (
    !closed(sqlite, ['status', 'driver', 'version', 'sourceId', 'manifestSha256']) ||
    sqlite.status !== 'passed' ||
    sqlite.driver !== 'bun:sqlite' ||
    !object(candidate) ||
    !object(candidate.sqlite) ||
    sqlite.version !== candidate.sqlite.version ||
    sqlite.sourceId !== candidate.sqlite.sourceId ||
    sqlite.manifestSha256 !== candidate.sqlite.manifestSha256
  )
    errors.push('platform_sqlite_case_invalid');
  if (
    object(files) &&
    object(assets) &&
    new Set([
      files.writeExecutionId,
      files.readExecutionId,
      assets.readExecutionId,
      assets.writeExecutionId,
    ]).size !== 4
  )
    errors.push('platform_execution_identity_invalid');
  if (
    !closed(value.leases, [
      'status',
      'twoIndependentShared',
      'exclusiveAfterParentClose',
      'exclusiveAfterAllClose',
    ]) ||
    value.leases.status !== 'passed' ||
    value.leases.twoIndependentShared !== true ||
    value.leases.exclusiveAfterParentClose !== 'busy' ||
    value.leases.exclusiveAfterAllClose !== 'acquired'
  )
    errors.push('platform_leases_case_invalid');
  return errors;
}
export function parseUnifiedPlatformVerifyArgs(args: readonly string[]) {
  let report: string | undefined, mode: 'diagnostic' | 'formal' | undefined;
  for (const arg of args) {
    if (arg.startsWith('--report=') && !report && isAbsolute(arg.slice(9)) && arg.length <= 4105)
      report = arg.slice(9);
    else if (arg === '--mode=diagnostic' && !mode) mode = 'diagnostic';
    else if (arg === '--mode=formal' && !mode) mode = 'formal';
    else throw Error('platform_verify_arguments_invalid');
  }
  if (args.length !== 2 || !report || !mode) throw Error('platform_verify_arguments_invalid');
  return { report, mode };
}
if (import.meta.main) {
  const args = parseUnifiedPlatformVerifyArgs(process.argv.slice(2));
  const fd = openSync(args.report, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let report: unknown;
  try {
    const actual = fstatSync(fd),
      path = lstatSync(args.report);
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      actual.size > 512 * 1024 ||
      actual.dev !== path.dev ||
      actual.ino !== path.ino ||
      path.isSymbolicLink()
    )
      throw Error('platform_report_file_invalid');
    report = JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
  const errors = verifyUnifiedPlatformReport(report, args.mode);
  console.log(
    JSON.stringify({
      version: 1,
      mode: args.mode,
      qualified: args.mode === 'formal' && errors.length === 0,
      diagnosticPassed: args.mode === 'diagnostic' && errors.length === 0,
      errors,
    }),
  );
  if (errors.length) process.exitCode = 1;
}
