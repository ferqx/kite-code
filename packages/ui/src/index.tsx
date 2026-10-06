import type { PublicView } from '@kite-ai/client';
import { type FormEvent, useId, useRef, useState } from 'react';
import { describeInput, serializeInput } from './form';

export type PublicAction = PublicView['actions'][number];

export { describeInput, type FormDescription, type InputField, serializeInput } from './form';

/** A fallback keeps the full public object, including future content versions and fields. */
export function projectPublicView(view: PublicView) {
  return {
    title: view.summary,
    contentType: view.contentType,
    version: view.contentVersion,
    raw: view,
    payloadText: JSON.stringify(view.payload, null, 2),
    actions: view.actions,
    artifacts: view.artifactRefs,
  };
}
export function PublicViewCard({
  view,
  onAction,
}: {
  view: PublicView;
  onAction?: (action: PublicAction) => void;
}) {
  const projected = projectPublicView(view);
  return (
    <article>
      <h3>{projected.title}</h3>
      <small>
        {projected.contentType} · v{projected.version}
      </small>
      <pre>{projected.payloadText}</pre>
      {projected.artifacts.length > 0 && (
        <ul>
          {projected.artifacts.map((artifact) => (
            <li key={artifact.id}>
              {artifact.id} · {artifact.mediaType} · {artifact.size} bytes
            </li>
          ))}
        </ul>
      )}
      <div>
        {projected.actions.map((action, index) => (
          <button
            key={`${action.actionId}:${index}`}
            type="button"
            disabled={!onAction}
            onClick={() => onAction?.(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </article>
  );
}
export type ConnectionState = {
  readonly kind: 'disconnected' | 'connecting' | 'ready' | 'unavailable' | 'error';
  readonly message?: string;
};
export function ConnectionNotice({ state }: { state: ConnectionState }) {
  return <p role={state.kind === 'error' ? 'alert' : 'status'}>{state.message ?? state.kind}</p>;
}

/** Rendering owns drafts only. The host provides the admitted, authorized submission callback. */
export type ActionInputDraft = { values: Record<string, string | boolean>; raw: string };
export function ActionInputForm({
  schema,
  initial = {},
  initialDraft,
  onDraftChange,
  disabled = false,
  onSubmit,
  submitLabel = 'Run action',
}: {
  schema: unknown;
  submitLabel?: string;
  initial?: Readonly<Record<string, unknown>>;
  initialDraft?: ActionInputDraft;
  onDraftChange?: (draft: ActionInputDraft) => void;
  disabled?: boolean;
  onSubmit: (input: unknown) => void | Promise<void>;
}) {
  const formId = useId();
  const form = describeInput(schema);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    if (initialDraft) return { ...initialDraft.values };
    const draft: Record<string, string | boolean> = Object.fromEntries(
      Object.entries(initial).map(([key, value]) => [
        key,
        typeof value === 'boolean'
          ? value
          : typeof value === 'string' || typeof value === 'number'
            ? String(value)
            : '',
      ]),
    );
    if (form.kind === 'fields')
      for (const field of form.fields)
        if (field.kind === 'boolean' && field.required && draft[field.name] === undefined)
          draft[field.name] = false;
    return draft;
  });
  const [raw, setRaw] = useState(() => initialDraft?.raw ?? JSON.stringify(initial, null, 2));
  const draft = useRef<ActionInputDraft>({ values, raw });
  function changeValues(name: string, value: string | boolean) {
    const next = { ...draft.current.values, [name]: value };
    draft.current = { ...draft.current, values: next };
    setValues(next);
    onDraftChange?.(draft.current);
  }
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || busy.current) return;
    busy.current = true;
    setError(undefined);
    setSubmitting(true);
    try {
      await onSubmit(
        form.kind === 'raw-json' ? JSON.parse(raw) : serializeInput(form, values, initial),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed');
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }
  return (
    <form onSubmit={submit}>
      {form.kind === 'raw-json' ? (
        <label>
          {form.reason}
          <textarea
            aria-label="Raw JSON input"
            value={raw}
            disabled={disabled || submitting}
            onInput={(event) => {
              const next = event.currentTarget.value;
              draft.current = { ...draft.current, raw: next };
              setRaw(next);
              onDraftChange?.(draft.current);
            }}
          />
        </label>
      ) : (
        form.fields.map((field) => (
          <label key={field.name} htmlFor={`${formId}-${field.name}`}>
            {field.label}
            {field.kind === 'boolean' ? (
              <input
                id={`${formId}-${field.name}`}
                type="checkbox"
                checked={values[field.name] === true}
                disabled={disabled || submitting}
                onChange={(event) => changeValues(field.name, event.target.checked)}
              />
            ) : field.kind === 'enum' ? (
              <select
                id={`${formId}-${field.name}`}
                value={String(values[field.name] ?? '')}
                required={field.required}
                disabled={disabled || submitting}
                onChange={(event) => changeValues(field.name, event.target.value)}
              >
                <option value="">Select</option>
                {field.choices?.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${formId}-${field.name}`}
                type={field.kind === 'number' || field.kind === 'integer' ? 'number' : 'text'}
                step={field.kind === 'integer' ? '1' : 'any'}
                value={String(values[field.name] ?? '')}
                required={field.required}
                disabled={disabled || submitting}
                onInput={(event) => changeValues(field.name, event.currentTarget.value)}
              />
            )}
          </label>
        ))
      )}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={disabled || submitting}>
        {submitLabel}
      </button>
    </form>
  );
}

export {
  type AttachmentReader,
  type InteractionAttachment,
  interactionAttachment,
  loadInteractionAttachment,
  requiresInteractionAttachment,
} from './attachments';
export { ContextPanel, ContextSubmissionNotice } from './context';
export {
  type InteractionAnswer,
  InteractionCard,
  type InteractionSubmission,
} from './interactions';
export { SafeMessageMarkdown } from './markdown';
export {
  type ModelInputDirectory,
  type ModelInputIdentity,
  type ModelInputPort,
  type ModelInputSnapshot,
  ModelInputs,
  readModelDirectory,
} from './model-input';
export { ModelOutputMessage, type ModelOutputMessageProps } from './model-output';
export {
  type PermissionFacts,
  type PermissionGrantFacts,
  PermissionGrantsPanel,
  PermissionPanel,
  type PermissionSubmissionNotice,
  PermissionSubmissionStatus,
} from './permissions';
export {
  describePlanReview,
  type PlanMode,
  PlanReviewPanel,
  serializePlanReviewAnswer,
} from './plan-review';
export { type QuestionAnswerDraft, questionDraftKey } from './questionnaire';
