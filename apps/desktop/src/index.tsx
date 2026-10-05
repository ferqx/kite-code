import type { Interaction, PublicView } from '@kite-ai/client';
import {
  ContextPanel,
  ContextSubmissionNotice,
  type InteractionAnswer,
  InteractionCard,
  type InteractionSubmission,
  PermissionPanel,
  PermissionSubmissionStatus,
  PublicViewCard,
} from '@kite-ai/ui';

export {
  type ContextSubmission,
  createDesktopController,
  DesktopController,
  type DesktopOptions,
  type DesktopSnapshot,
  type InteractionAnswerSubmission,
  type QuerySelection,
} from './controller';
export { DesktopInput, type InputOptions, type InputRequest, type InputSubmission } from './input';

/** A thin generic renderer; the portable main adapter supplies facts and admitted actions. */
export function DesktopPublicViews({
  views,
  onAction,
}: {
  views: readonly PublicView[];
  onAction?: (action: PublicView['actions'][number]) => void;
}) {
  return (
    <section>
      {views.map((view, index) => (
        <PublicViewCard
          key={`${view.extensionId}:${view.contentType}:${index}`}
          view={view}
          onAction={onAction}
        />
      ))}
    </section>
  );
}

/** Callback absence renders persisted interactions read only, including Web callers. */
export function DesktopInteractions({
  interactions,
  submissions,
  onAnswer,
  onReadAttachment,
}: {
  interactions: readonly Interaction[];
  onReadAttachment?: import('@kite-ai/ui').AttachmentReader;
  submissions?: ReadonlyMap<string, InteractionSubmission>;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
}) {
  return (
    <section>
      {interactions.map((interaction) => (
        <InteractionCard
          key={`${interaction.originStoreId}:${interaction.id}:${interaction.revision}`}
          interaction={interaction}
          submission={submissions?.get(interaction.id)}
          onAnswer={onAnswer}
          onReadAttachment={onReadAttachment}
        />
      ))}
    </section>
  );
}

/** Render saved answer panels separately from selection, so switching pages preserves them. */
export function DesktopAnswerSubmissions({
  submissions,
}: {
  submissions: readonly import('./controller').InteractionAnswerSubmission[];
}) {
  return (
    <section aria-label="Saved interaction answers">
      {submissions.map((state) => (
        <InteractionCard
          key={state.intent.commandId}
          interaction={state.interaction}
          submission={{ phase: state.phase, commandId: state.intent.commandId, error: state.error }}
        />
      ))}
    </section>
  );
}

export { ContextPanel, ContextSubmissionNotice } from '@kite-ai/ui';

export function DesktopContext({
  snapshot,
  onRewind,
  onInclude,
  onNextPage,
  submissions = [],
}: {
  snapshot: import('./controller').DesktopSnapshot;
  onRewind?: (
    boundary: import('@kite-ai/client').SelectContextRequest['boundary'],
  ) => void | Promise<void>;
  onInclude?: (
    execution: import('@kite-ai/client').Execution,
    scope: { storeId: string; sessionId: string; contextSelectionId: string; targetRunId?: string },
  ) => void | Promise<void>;
  onNextPage?: () => void | Promise<void>;
  submissions?: readonly import('./controller').ContextSubmission[];
}) {
  const busy =
    snapshot.view.runs.some((run) => run.isActive) ||
    snapshot.view.executions.some((execution) =>
      ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(execution.status),
    );
  return (
    <section>
      {snapshot.context ? (
        <ContextPanel
          context={snapshot.context}
          history={snapshot.view.executions}
          storeId={snapshot.view.storeId}
          activeRun={
            snapshot.view.runs.filter((run) => run.isActive).length === 1
              ? snapshot.view.runs.find((run) => run.isActive)
              : undefined
          }
          busy={
            busy ||
            submissions.some(
              (state) =>
                state.sessionId === snapshot.sessionId &&
                ['saved', 'submitting', 'unknown'].includes(state.phase),
            )
          }
          onRewind={onRewind}
          onInclude={
            submissions.some(
              (state) =>
                state.sessionId === snapshot.sessionId &&
                ['saved', 'submitting', 'unknown', 'queued'].includes(state.phase),
            )
              ? undefined
              : onInclude
          }
          onNextPage={onNextPage}
        />
      ) : (
        <p>Context capability unavailable</p>
      )}
      {submissions.map((state) => (
        <ContextSubmissionNotice
          key={state.intent.commandId}
          submission={{
            kind: state.kind,
            commandId: state.intent.commandId,
            phase: state.phase,
            error: state.error,
          }}
        />
      ))}
    </section>
  );
}

export { PermissionPanel, PermissionSubmissionStatus } from '@kite-ai/ui';
export type { DesktopPermissionFacts, PermissionSubmission } from './controller';

export function DesktopPermissions({
  snapshot,
  controller,
}: {
  snapshot: import('./controller').DesktopSnapshot;
  controller?: import('./controller').DesktopController;
}) {
  const facts = snapshot.permissions;
  const states = controller?.permissionSubmissions ?? [];
  const busy = states.some((state) => ['saved', 'submitting', 'unknown'].includes(state.phase));
  return (
    <section>
      <PermissionPanel
        facts={facts}
        busy={busy}
        onSetMode={
          controller && facts
            ? (mode, makeDefault) =>
                controller.setPermissionMode(mode, makeDefault, facts.observationId)
            : undefined
        }
        onSetTrust={
          controller && facts
            ? (trusted) => controller.setWorkspaceTrust(trusted, facts.observationId)
            : undefined
        }
        onRefresh={controller ? () => controller.refreshPermissions() : undefined}
      />
      {states.map((state) => (
        <div key={state.intent.commandId}>
          <PermissionSubmissionStatus
            submission={{
              commandId: state.intent.commandId,
              phase: state.phase,
              error: state.error,
            }}
          />
          {controller && state.phase === 'unknown' && (
            <button
              type="button"
              onClick={() => {
                void controller.lookupPermissionMutation(state.intent.commandId).catch(() => {});
              }}
            >
              查询原选择回执
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
