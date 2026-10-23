import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runLiveAgentIdentities } from './collaboration-agent-identities.live';
import { runLiveApprovalRaces } from './collaboration-approval-races.live';
import {
  liveAttachedShellCaseIds,
  runLiveAttachedShell,
} from './collaboration-attached-shell.live';
import { liveBoundedBodyCaseIds, runLiveBoundedBody } from './collaboration-bounded-body.live';
import { runLiveCollaborationCancellation } from './collaboration-cancellation.live';
import { runLiveCommandRaces } from './collaboration-command-races.live';
import { runLiveCollaborationCompaction } from './collaboration-compaction.live';
import { runLiveDirectoryBoundaries } from './collaboration-directory-boundaries.live';
import { runLiveCollaborationFiles } from './collaboration-files.live';
import { runLiveExternalFilesBoundaries } from './collaboration-files-external-boundaries.live';
import { runLiveFilesPartial } from './collaboration-files-partial.live';
import { runLiveFilesPartialDefault } from './collaboration-files-partial-default.live';
import { runLiveGrantRaces } from './collaboration-grant-races.live';
import { runLiveIdleQuestion } from './collaboration-idle-question.live';
import { runLiveIdleQuestionBlue } from './collaboration-idle-question-blue.live';
import {
  type CollaborationInputCaseId,
  runCollaborationInputCases,
} from './collaboration-inputs.live';
import { runLiveInterruptGeneration } from './collaboration-interrupt-generation.live';
import { liveMailAdoptionCaseIds, runLiveMailAdoption } from './collaboration-mail-adoption.live';
import { runLiveNotificationReliability } from './collaboration-notification-reliability.live';
import { runLiveObservationOrders } from './collaboration-observation-orders.live';
import { runLivePermissionBoundaries } from './collaboration-permission-boundaries.live';
import { runLiveCollaborationPermissions } from './collaboration-permissions.live';
import {
  type CollaborationQuestionCaseId,
  runCollaborationQuestionCases,
} from './collaboration-questions.live';
import { runLiveQueuedAgentRaces } from './collaboration-queued-agents.live';
import { runLiveResultAcceptanceOrders } from './collaboration-result-acceptance-orders.live';
import { runLiveResultCoalescing } from './collaboration-result-coalescing.live';
import { runLiveResultTransactions } from './collaboration-result-transactions.live';
import { runLiveStaleApprovals } from './collaboration-stale-approvals.live';
import { runLiveTaskPreset, taskPresetCaseIds } from './collaboration-task-presets.live';
import {
  type CollaborationTitleCaseId,
  runCollaborationTitleCases,
} from './collaboration-titles.live';
import { runLiveTreePermissions } from './collaboration-tree-permissions.live';
import { liveUnifiedInboxCaseIds, runLiveUnifiedInbox } from './collaboration-unified-inbox.live';
import { runLiveUntrustedResults } from './collaboration-untrusted-results.live';
import { runLiveWorkControls } from './collaboration-work-controls.live';
import { runLiveWorkScope } from './collaboration-work-scope.live';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture, summarizeLiveToolCalls } from './live-model-fixture';

// Explicit test artifact only. No configuration or network access without the opt-in gate.
if (process.env.KITE_RUN_LIVE_COLLABORATION !== '1')
  throw Error('live_collaboration_requires_KITE_RUN_LIVE_COLLABORATION_1');
const args = process.argv.slice(2);
const parsed = new Map<string, string>();
for (const arg of args) {
  const match = /^--(group|case|output)=(.+)$/.exec(arg);
  if (!match || parsed.has(match[1]!)) throw Error('live_collaboration_arguments_invalid');
  parsed.set(match[1]!, match[2]!);
}
const group = parsed.get('group');
const caseId = parsed.get('case');
const output = parsed.get('output');
const inputCases = [
  'I01',
  'I02',
  'I03',
  'I03-active',
  'I04',
  'I04-result-first',
  'I05',
  'I06',
  'I07',
  'I08-queued',
  'I08-running',
  'I09',
  'I09-clarified',
  'I09-dual-clarified',
  'I09-dual-active-clarified',
  'I09-dual-active-question-clarified',
  'I10',
  'I11',
  'I11-retrieved-record',
  'I11-current-control',
  'I11-contradictory-control',
];
const permissionCases = [
  'permissions-approve',
  'permissions-deny',
  'permissions-relax',
  'permissions-tighten',
  'permissions-untrusted',
];
const titleCases = ['S01', 'S02', 'S03'];
const questionCases = ['R02', 'R09'];
const fileCases = ['F01'];
const filesPartialDefaultCases = ['F02-default-policy-external-exact-approval-partial-conflict'];
const filesPartialCases = ['F02-X-success-Y-conflict-then-explicit-fresh-baseline'];
const externalFilesBoundaryCases = [
  'F03-external-process-same-inode-mtime-old-baseline-conflict',
  'F03-real-publication-postcapture-confirmation-unknown',
];
const cancellationCases = ['cancellation-attached-branch', 'cancellation-root-stop'];
const approvalRaceCases = [
  'P04-cancel-first',
  'P04-dispatch-first',
  'P04-parent-cancel-first',
  'P04-parent-dispatch-first',
  'P04-root-cancel-first',
  'P04-root-dispatch-first',
];
const grantRaceCases = ['P08-grant-revision', 'P08-review-revision'];
const commandRaceCases = ['A04-active-follow-up', 'C01-spawn-response-loss'];
const queuedAgentCases = ['A06-queued-two-guidance', 'A08-queued-interrupt'];
const observationOrderCases = [
  'A02-wait-first',
  'A02-other-work-completed-before-wait',
  'C02-identical-new-invocations',
];
const interruptGenerationCases = ['A08-pinned-old-receipt-new-run'];
const staleApprovalCases = ['P03-old-answered', 'P03-old-denied', 'P03-old-cancelled'];
const workScopeCases = ['I13-running-cross-work-reuse', 'I13-queued-cross-work-reuse'];
const untrustedResultCases = [
  'I12-report-while-approval-pending',
  'I12-report-during-B-then-explicit-A',
];
const resultCoalescingCases = [
  'R03-simultaneous-results',
  'R03-started-parent-second-result-and-B-deferred',
  'R03-dispatched-parent-second-result-and-B-deferred',
];
const resultAcceptanceOrderCases = [
  'R04-parent-completes-before-report-transaction',
  'R04-stop-after-acceptance-before-prepared',
  'R04-normal-completion-receives-accepted-source',
];
const resultTransactionCases = [
  'R05-child-terminal-report-registration-rollback',
  'R05-idle-report-committed-response-loss',
];
const workControlCases = [
  'I14-pause-continue-before-result',
  'I14-pause-result-before-continue',
  'I14-stop-continue-late-report',
  'R06-revoked-report-terminal-binding-release-idle',
];
const agentIdentityCases = ['A09-same-name-missing-id-and-owned-store-negative-probes'];
const directoryBoundaryCases = [
  'A12-fixed-upper-real-followup-and-fourth-spawn',
  'A12-initial-high-sequence-fixed-upper-and-scope',
];
const permissionBoundaryCases = [
  'P10-mode-committed-response-loss-original-child',
  'P10-current-policy-read-failure-before-dispatch',
];
const boundedBodyCases = [...liveBoundedBodyCaseIds];
const compactionCases = [
  'R10-real-parent-child-automatic-compression-stable-identity-cold-read',
  'R10-real-compression-initial-high-command-and-event-sequences',
];
const treeCases = [
  'tree-two-child-exact-approval',
  'tree-descendant-mode-relax',
  'tree-descendant-mode-tighten',
  'tree-queued-mode-relax',
];
const idleQuestionCases = [
  'R08-idle-parent-one-real-30000ms-question-observation-pending',
  'R08-idle-parent-30000ms-pending-then-human-Blue-same-child-current-baseline',
];
const notificationReliabilityCases = [
  'R12-all-optional-observers-absent',
  'R12-slow-throwing-observer-disabled-durable-report',
];
const selectedCases =
  group === 'attached-shell' || group === 'unified-inbox'
    ? [...(group === 'unified-inbox' ? liveUnifiedInboxCaseIds : liveAttachedShellCaseIds)]
    : group === 'idle-question' || group === 'mail-adoption'
      ? group === 'mail-adoption'
        ? [...liveMailAdoptionCaseIds]
        : idleQuestionCases
      : group === 'notification-reliability'
        ? notificationReliabilityCases
        : group === 'external-files-boundaries'
          ? externalFilesBoundaryCases
          : group === 'bounded-body' || group === 'collaboration-compaction'
            ? group === 'collaboration-compaction'
              ? compactionCases
              : boundedBodyCases
            : group === 'directory-boundaries'
              ? directoryBoundaryCases
              : group === 'permission-boundaries'
                ? permissionBoundaryCases
                : group === 'files-partial' || group === 'files-partial-default'
                  ? group === 'files-partial-default'
                    ? filesPartialDefaultCases
                    : filesPartialCases
                  : group === 'agent-identities'
                    ? agentIdentityCases
                    : group === 'work-controls'
                      ? workControlCases
                      : group === 'result-transactions'
                        ? resultTransactionCases
                        : group === 'result-coalescing'
                          ? resultCoalescingCases
                          : group === 'result-acceptance-orders'
                            ? resultAcceptanceOrderCases
                            : group === 'inputs'
                              ? inputCases
                              : group === 'titles'
                                ? titleCases
                                : group === 'questions'
                                  ? questionCases
                                  : group === 'files'
                                    ? fileCases
                                    : group === 'cancellation'
                                      ? cancellationCases
                                      : group === 'tree-permissions'
                                        ? treeCases
                                        : group === 'approval-races'
                                          ? approvalRaceCases
                                          : group === 'grant-races'
                                            ? grantRaceCases
                                            : group === 'command-races'
                                              ? commandRaceCases
                                              : group === 'queued-agents'
                                                ? queuedAgentCases
                                                : group === 'observation-orders'
                                                  ? observationOrderCases
                                                  : group === 'interrupt-generation'
                                                    ? interruptGenerationCases
                                                    : group === 'stale-approvals'
                                                      ? staleApprovalCases
                                                      : group === 'work-scope'
                                                        ? workScopeCases
                                                        : group === 'untrusted-results'
                                                          ? untrustedResultCases
                                                          : permissionCases;
const allowedCases = group === 'task-presets' ? taskPresetCaseIds : selectedCases;
if (
  !caseId ||
  ![
    'inputs',
    'permissions',
    'titles',
    'tree-permissions',
    'questions',
    'files',
    'cancellation',
    'approval-races',
    'grant-races',
    'command-races',
    'queued-agents',
    'observation-orders',
    'interrupt-generation',
    'stale-approvals',
    'work-scope',
    'untrusted-results',
    'result-coalescing',
    'result-acceptance-orders',
    'result-transactions',
    'work-controls',
    'agent-identities',
    'files-partial',
    'files-partial-default',
    'directory-boundaries',
    'permission-boundaries',
    'bounded-body',
    'collaboration-compaction',
    'external-files-boundaries',
    'idle-question',
    'mail-adoption',
    'notification-reliability',
    'attached-shell',
    'task-presets',
    'unified-inbox',
  ].includes(group ?? '') ||
  !allowedCases.includes(caseId) ||
  (output !== undefined &&
    (!isAbsolute(output) || existsSync(output) || existsSync(`${output}.workspace`)))
)
  throw Error('live_collaboration_arguments_invalid');

const started = performance.now();
const report: Record<string, unknown> = {
  version: 1,
  date: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  group,
  caseId,
  entryLayer:
    group === 'unified-inbox' ||
    group === 'task-presets' ||
    group === 'mail-adoption' ||
    group === 'collaboration-compaction' ||
    group === 'attached-shell'
      ? 'owned-runtime-sqlite'
      : 'service-client-runtime-sqlite',
  ...(group === 'bounded-body'
    ? {
        bodyAcceptanceContract:
          caseId === 'F04-bounded-semantic-report-full-generated-child-carrier-parent-body'
            ? 'semantic-facts/full-generated-child-body'
            : 'explicit-source-copy-precision',
      }
    : {}),
  requestLimit: 40,
  timeoutMs: 600_000,
  network: 'configured-provider-direct-no-fallback',
  status: 'inconclusive',
  code: liveCodeEvidence(),
};
let fixture: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
try {
  fixture = await createLiveModelFixture({
    requestLimit: 40,
    timeoutMs: 600_000,
    ...(caseId === 'F04-bounded-complete-Files-child-carrier-parent-body-8192-output-tokens'
      ? { outputTokenLimit: 8192 as const }
      : {}),
  });
  Object.assign(report, fixture.metadata);
  const options = {
    model: fixture.model,
    modelId: fixture.modelId,
    signal: fixture.signal,
    requests: () => fixture!.requests,
    ...(output ? { evidenceRoot: `${output}.workspace` } : {}),
  };
  const results =
    group === 'attached-shell' || group === 'task-presets' || group === 'unified-inbox'
      ? group === 'task-presets'
        ? (await runLiveTaskPreset({ ...options, caseId })).cases
        : (
            await (group === 'unified-inbox' ? runLiveUnifiedInbox : runLiveAttachedShell)({
              ...options,
              caseIds: [caseId],
            })
          ).cases
      : group === 'idle-question' || group === 'mail-adoption'
        ? (
            await (group === 'mail-adoption'
              ? runLiveMailAdoption
              : caseId ===
                  'R08-idle-parent-30000ms-pending-then-human-Blue-same-child-current-baseline'
                ? runLiveIdleQuestionBlue
                : runLiveIdleQuestion)({ ...options, caseIds: [caseId] })
          ).cases
        : group === 'notification-reliability'
          ? (await runLiveNotificationReliability({ ...options, caseIds: [caseId] })).cases
          : group === 'external-files-boundaries'
            ? (await runLiveExternalFilesBoundaries({ ...options, caseIds: [caseId] })).cases
            : group === 'bounded-body' || group === 'collaboration-compaction'
              ? group === 'collaboration-compaction'
                ? (await runLiveCollaborationCompaction({ ...options, caseIds: [caseId] })).cases
                : (await runLiveBoundedBody({ ...options, caseIds: [caseId] })).cases
              : group === 'directory-boundaries'
                ? (await runLiveDirectoryBoundaries({ ...options, caseIds: [caseId] })).cases
                : group === 'permission-boundaries'
                  ? (await runLivePermissionBoundaries({ ...options, caseIds: [caseId] })).cases
                  : group === 'files-partial' || group === 'files-partial-default'
                    ? group === 'files-partial-default'
                      ? (await runLiveFilesPartialDefault({ ...options, caseIds: [caseId] })).cases
                      : (await runLiveFilesPartial({ ...options, caseIds: [caseId] })).cases
                    : group === 'agent-identities'
                      ? (await runLiveAgentIdentities({ ...options, caseIds: [caseId] })).cases
                      : group === 'work-controls'
                        ? (await runLiveWorkControls({ ...options, caseIds: [caseId] })).cases
                        : group === 'result-transactions'
                          ? (await runLiveResultTransactions({ ...options, caseIds: [caseId] }))
                              .cases
                          : group === 'result-coalescing'
                            ? (await runLiveResultCoalescing({ ...options, caseIds: [caseId] }))
                                .cases
                            : group === 'result-acceptance-orders'
                              ? (
                                  await runLiveResultAcceptanceOrders({
                                    ...options,
                                    caseIds: [caseId],
                                  })
                                ).cases
                              : group === 'inputs'
                                ? await runCollaborationInputCases({
                                    ...options,
                                    caseIds: [caseId as CollaborationInputCaseId],
                                  })
                                : group === 'titles'
                                  ? await runCollaborationTitleCases({
                                      ...options,
                                      caseIds: [caseId as CollaborationTitleCaseId],
                                    })
                                  : group === 'questions'
                                    ? await runCollaborationQuestionCases({
                                        ...options,
                                        caseIds: [caseId as CollaborationQuestionCaseId],
                                      })
                                    : group === 'files'
                                      ? (
                                          await runLiveCollaborationFiles({
                                            ...options,
                                            caseIds: [caseId],
                                          })
                                        ).cases
                                      : group === 'cancellation'
                                        ? (
                                            await runLiveCollaborationCancellation({
                                              ...options,
                                              caseIds: [caseId],
                                            })
                                          ).cases
                                        : group === 'approval-races'
                                          ? (
                                              await runLiveApprovalRaces({
                                                ...options,
                                                caseIds: [caseId],
                                              })
                                            ).cases
                                          : group === 'grant-races'
                                            ? (
                                                await runLiveGrantRaces({
                                                  ...options,
                                                  caseIds: [caseId],
                                                })
                                              ).cases
                                            : group === 'command-races'
                                              ? (
                                                  await runLiveCommandRaces({
                                                    ...options,
                                                    caseIds: [caseId],
                                                  })
                                                ).cases
                                              : group === 'queued-agents'
                                                ? (
                                                    await runLiveQueuedAgentRaces({
                                                      ...options,
                                                      caseIds: [caseId],
                                                    })
                                                  ).cases
                                                : group === 'observation-orders'
                                                  ? (
                                                      await runLiveObservationOrders({
                                                        ...options,
                                                        caseIds: [caseId],
                                                      })
                                                    ).cases
                                                  : group === 'interrupt-generation'
                                                    ? (
                                                        await runLiveInterruptGeneration({
                                                          ...options,
                                                          caseIds: [caseId],
                                                        })
                                                      ).cases
                                                    : group === 'stale-approvals'
                                                      ? (
                                                          await runLiveStaleApprovals({
                                                            ...options,
                                                            caseIds: [caseId],
                                                          })
                                                        ).cases
                                                      : group === 'work-scope'
                                                        ? (
                                                            await runLiveWorkScope({
                                                              ...options,
                                                              caseIds: [caseId],
                                                            })
                                                          ).cases
                                                        : group === 'untrusted-results'
                                                          ? (
                                                              await runLiveUntrustedResults({
                                                                ...options,
                                                                caseIds: [caseId],
                                                              })
                                                            ).cases
                                                          : group === 'tree-permissions'
                                                            ? (
                                                                await runLiveTreePermissions({
                                                                  ...options,
                                                                  caseIds: [caseId],
                                                                })
                                                              ).cases
                                                            : (
                                                                await runLiveCollaborationPermissions(
                                                                  {
                                                                    ...options,
                                                                    caseIds: [caseId],
                                                                  },
                                                                )
                                                              ).cases;
  if (results.length !== 1) throw Error('live_collaboration_case_not_run');
  report.cases = results;
  report.status = results[0]!.status;
  process.exitCode =
    report.status === 'passed'
      ? 0
      : report.status === 'failed'
        ? 1
        : report.status === 'blocked'
          ? 3
          : 2;
} catch (error) {
  report.status = 'failed';
  report.error =
    error instanceof Error && /^(live_model|live_collaboration)_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'live_collaboration_unexpected_failure';
  process.exitCode = 1;
} finally {
  report.monotonicDurationMs = performance.now() - started;
  report.finishedAt = new Date().toISOString();
  if (fixture) {
    report.providerRequests = fixture.wire.length;
    report.modelRequests = fixture.requests.length;
    report.httpStatuses = fixture.wire.map((row) => row.status);
    report.toolCalls = summarizeLiveToolCalls(fixture.requests, fixture.calls);
    report.usage = {
      knownInputTokens: fixture.usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
      knownOutputTokens: fixture.usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
      requestsWithUsage: fixture.usage.length,
      requestsWithInputTokens: fixture.usage.filter((row) => row.inputTokens !== null).length,
      requestsWithOutputTokens: fixture.usage.filter((row) => row.outputTokens !== null).length,
    };
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, text, { flag: 'wx', mode: 0o600 });
  console.log(text);
}
