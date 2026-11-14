import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { documentTemporaryRoot, exportDocument } from './document-export';
import { type OfficeProcessResult, type OfficeRunner, runOfficeCLI } from './office-runtime';

type Warning = { code?: string; message?: string };
type Envelope = {
  success: boolean;
  error?: unknown;
  warnings?: Warning[];
  data?: {
    results?: { index: number; success: boolean; warnings?: Warning[] }[];
    errors?: unknown[];
    count?: number;
    issues?: { severity?: unknown; subtype?: unknown }[];
  };
};
function envelope(result: OfficeProcessResult) {
  let value: Envelope;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw Error('office_result_invalid');
  }
  if (!value || typeof value !== 'object' || value.success !== true)
    throw Error(`office_operation_failed:${JSON.stringify(value?.error ?? {}).slice(0, 2048)}`);
  return value;
}
export function inspectOfficeBatch(result: OfficeProcessResult, count: number): string[] {
  const value = envelope(result);
  if (
    ![0, 2].includes(result.code) ||
    !Array.isArray(value.data?.results) ||
    value.data.results.length !== count ||
    value.data.results.some((item, index) => item.index !== index || item.success !== true)
  )
    throw Error('office_batch_failed');
  const warnings = [
    ...(Array.isArray(value.warnings) ? value.warnings : []),
    ...value.data.results.flatMap((item) => (Array.isArray(item.warnings) ? item.warnings : [])),
  ];
  if (
    result.code === 2 &&
    !warnings.some((warning) => warning.code === 'unrecognized_latex_command')
  )
    throw Error('office_batch_exit_unexplained');
  return warnings
    .slice(0, 8)
    .map((warning) => String(warning.code ?? warning.message ?? 'office_warning').slice(0, 160));
}
export function inspectExcelIssues(result: OfficeProcessResult): string[] {
  const value = envelope(result);
  if (result.code !== 0 || !Array.isArray(value.data?.issues))
    return ['calculation_not_fully_verified'];
  let incomplete =
    !Number.isSafeInteger(value.data.count) || value.data.count !== value.data.issues.length;
  for (const issue of value.data.issues) {
    if (!issue || typeof issue !== 'object' || typeof issue.subtype !== 'string') {
      incomplete = true;
      continue;
    }
    if (['formula_eval_error', 'formula_ref_missing_sheet'].includes(issue.subtype))
      throw Error(`office_formula_invalid:${issue.subtype}`);
    if (['formula_not_evaluated', 'formula_cache_stale'].includes(issue.subtype)) incomplete = true;
    // Fixed OfficeCLI JSON serializes severity as a numeric enum (0=error). Unknown shapes remain incomplete.
    if (![0, 1, 2].includes(issue.severity as number)) incomplete = true;
  }
  return incomplete ? ['calculation_not_fully_verified'] : [];
}
/** Copy-on-write: no output appears before all required checks. Never mutates the source. */
export async function createOfficeDocument(input: {
  format?: string;
  source?: string;
  operations: unknown;
  out: string;
  signal?: AbortSignal;
  run?: OfficeRunner;
}) {
  const format = input.source ? extname(input.source).slice(1).toLowerCase() : input.format;
  if (
    !format ||
    !['docx', 'xlsx', 'pptx'].includes(format) ||
    (input.source && input.format) ||
    extname(input.out).toLowerCase() !== `.${format}` ||
    !Array.isArray(input.operations) ||
    input.operations.length > 5000 ||
    Buffer.byteLength(JSON.stringify(input.operations)) > 8 * 1024 * 1024
  )
    throw Error('office_input_invalid');
  if (
    input.operations.some(
      (operation) =>
        !operation ||
        typeof operation !== 'object' ||
        typeof operation.command !== 'string' ||
        ['open', 'close', 'watch', 'install', 'update'].includes(operation.command.toLowerCase()),
    )
  )
    throw Error('office_batch_operation_invalid');
  const signal = input.signal ?? new AbortController().signal;
  const run = input.run ?? ((args, signal) => runOfficeCLI({ args, signal }));
  const directory = await mkdtemp(join(documentTemporaryRoot(), 'kite-documents-'));
  const draft = join(directory, `working.${format}`);
  let uncertain = false;
  try {
    if (input.source) {
      const info = await lstat(input.source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024)
        throw Error('office_source_invalid');
      await exportDocument(input.source, draft, signal);
    } else {
      const result = await run(['create', draft, '--json'], signal);
      envelope(result);
      if (result.code !== 0) throw Error('office_create_failed');
    }
    const ops = join(directory, 'operations.json');
    await writeFile(ops, JSON.stringify(input.operations), { mode: 0o600 });
    const warnings = inspectOfficeBatch(
      await run(['batch', draft, '--input', ops, '--json'], signal),
      input.operations.length,
    );
    const validation = await run(['validate', draft, '--json'], signal);
    const value = envelope(validation);
    if (
      validation.code !== 0 ||
      !Array.isArray(value.data?.errors) ||
      value.data.errors.length ||
      value.data.count !== 0
    )
      throw Error('office_validation_failed');
    if (format === 'xlsx') {
      try {
        warnings.push(
          ...inspectExcelIssues(
            await run(['view', draft, 'issues', '--type', 'content', '--json'], signal),
          ),
        );
      } catch (error) {
        if (
          signal.aborted ||
          String(error).includes('office_formula_invalid') ||
          String(error).includes('exit_unconfirmed') ||
          [
            'office_process_cleanup_unconfirmed',
            'office_process_scope_changed',
            'office_process_output_incomplete',
          ].includes(error instanceof Error ? error.message : String(error)) ||
          /^windows_path_security_[a-z_]+$/.test(
            error instanceof Error ? error.message : String(error),
          )
        )
          throw error;
        warnings.push('calculation_not_fully_verified');
      }
    }
    signal.throwIfAborted();
    const stat = await lstat(draft);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 256 * 1024 * 1024)
      throw Error('office_output_invalid');
    await exportDocument(draft, input.out, signal);
    return {
      success: true,
      name: basename(input.out),
      operations: input.operations.length,
      warnings: [...new Set(warnings)].slice(0, 8),
    };
  } catch (error) {
    uncertain = String(error).includes('exit_unconfirmed');
    throw error;
  } finally {
    if (!uncertain) await rm(directory, { recursive: true, force: true });
  }
}
