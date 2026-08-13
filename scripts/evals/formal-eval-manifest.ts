import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FORMAL_EVAL_POLICY_REVISION } from './formal-eval-identity';

interface FormalReportInput {
  label: string;
  content: string;
}

export function buildFormalEvaluationManifestV1(input: {
  candidateCommit: string;
  usageWindowStartedAt: string;
  usageWindowEndedAt: string;
  reports: readonly FormalReportInput[];
}): Record<string, unknown> {
  const candidateCommit = input.candidateCommit.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) throw new Error('manifest_candidate_invalid');
  const startedAt = new Date(input.usageWindowStartedAt);
  const endedAt = new Date(input.usageWindowEndedAt);
  if (
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(endedAt.getTime()) ||
    startedAt.getTime() >= endedAt.getTime()
  ) {
    throw new Error('manifest_usage_window_invalid');
  }
  if (input.reports.length === 0) throw new Error('manifest_reports_required');
  const labels = new Set<string>();
  const reports = input.reports.map((entry) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(entry.label) || labels.has(entry.label)) {
      throw new Error('manifest_report_label_invalid');
    }
    labels.add(entry.label);
    const report = JSON.parse(entry.content) as Record<string, unknown>;
    const identity = report.evaluationIdentity as Record<string, unknown> | undefined;
    if (
      identity?.formal !== true ||
      identity.policyRevision !== FORMAL_EVAL_POLICY_REVISION ||
      identity.candidateCommit !== candidateCommit
    ) {
      throw new Error('manifest_report_identity_mismatch');
    }
    const status = report.status;
    const schema = report.schema;
    if (typeof schema !== 'string' || typeof status !== 'string') {
      throw new Error('manifest_report_shape_invalid');
    }
    const accepted =
      (schema === 'FirstDecisionEvalV1' && status === 'completed') ||
      (schema === 'PromptCacheTransitionEvalV1' && status === 'passed') ||
      (schema === 'LiveTaskJourneyEvalV1' && status === 'completed');
    if (!accepted) throw new Error('manifest_report_not_accepted');
    return {
      label: entry.label,
      schema,
      status,
      sha256: createHash('sha256').update(entry.content).digest('hex'),
    };
  });
  return {
    schema: 'FormalPromptEvaluationEvidenceV1',
    policyRevision: FORMAL_EVAL_POLICY_REVISION,
    candidateCommit,
    goUsageChecked: true,
    usageWindow: {
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    },
    reports,
    contentLogged: false,
  };
}

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

if (import.meta.main) {
  try {
    const reportArgs = process.argv.filter((arg) => arg.startsWith('--report='));
    const manifest = buildFormalEvaluationManifestV1({
      candidateCommit: requiredArg('candidate-commit'),
      usageWindowStartedAt: requiredArg('usage-start'),
      usageWindowEndedAt: requiredArg('usage-end'),
      reports: reportArgs.map((arg) => {
        const value = arg.slice('--report='.length);
        const separator = value.indexOf(':');
        if (separator <= 0) throw new Error('report_argument_invalid');
        return {
          label: value.slice(0, separator),
          content: readFileSync(resolve(value.slice(separator + 1)), 'utf8'),
        };
      }),
    });
    const outputPath = resolve(requiredArg('output'));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(outputPath, 0o600);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schema: 'FormalPromptEvaluationEvidenceV1',
        status: 'failed',
        reason: error instanceof Error ? error.message : 'manifest_failed',
        contentLogged: false,
      })}\n`,
    );
    process.exitCode = 1;
  }
}
