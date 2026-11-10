import { decimal64Schema, toolResultPresentationSchema } from '@kite-ai/trajectory';
import { AgentError, type Json } from '../storage/types';

export function evidenceObject(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('trajectory_evidence_unavailable');
  return value;
}
function strings(value: Record<string, Json>, names: string[]): Record<string, Json> {
  return Object.fromEntries(
    names.flatMap((name) => (typeof value[name] === 'string' ? [[name, value[name]!]] : [])),
  );
}
function object(value: Json | undefined): Record<string, Json> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function publicOptions(value: Json | undefined, approval = false): Json[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const option = object(item);
        if (!option) return [];
        const presentation = approval ? object(option.presentation) : undefined;
        const label = typeof option.label === 'string' ? option.label : presentation?.label;
        if (typeof label !== 'string') return [];
        const id =
          typeof option.id === 'string'
            ? option.id
            : approval && typeof option.optionId === 'string'
              ? option.optionId
              : undefined;
        const description =
          typeof option.description === 'string'
            ? option.description
            : Array.isArray(presentation?.details) &&
                presentation.details.every((item) => typeof item === 'string')
              ? presentation.details.join('\n')
              : undefined;
        return [
          { label, ...(id !== undefined ? { id } : {}), ...(description ? { description } : {}) },
        ];
      })
    : [];
}
function publicQuestions(request: Record<string, Json>): Json[] {
  if (Array.isArray(request.questions))
    return request.questions.flatMap((item) => {
      const question = object(item);
      return question && typeof question.id === 'string' && typeof question.question === 'string'
        ? [
            {
              ...strings(question, ['id', 'header', 'question']),
              ...(typeof question.multiSelect === 'boolean'
                ? { multiSelect: question.multiSelect }
                : {}),
              ...(Array.isArray(question.options)
                ? { options: publicOptions(question.options) }
                : {}),
            },
          ]
        : [];
    });
  const schema = object(request.schema);
  if (!schema) return [];
  const branches =
    schema.type === 'object'
      ? [schema]
      : (Array.isArray(schema.oneOf)
          ? schema.oneOf
          : Array.isArray(schema.anyOf)
            ? schema.anyOf
            : []
        ).flatMap((item) => {
          const branch = object(item);
          return branch?.type === 'object' && object(branch.properties) ? [branch] : [];
        });
  // More than one object alternative does not identify one original question form.
  if (branches.length !== 1) return [];
  return Object.entries(object(branches[0]!.properties) ?? {}).flatMap(([id, value]) => {
    const question = object(value);
    if (!question || typeof question.title !== 'string') return [];
    const choices = question.type === 'array' ? object(question.items) : question;
    const alternatives = choices && Array.isArray(choices.anyOf) ? choices.anyOf : [];
    const options = alternatives.flatMap((item) => {
      const option = object(item);
      return option && typeof option.const === 'string' && typeof option.title === 'string'
        ? [{ id: option.const, label: option.title, ...strings(option, ['description']) }]
        : [];
    });
    return [
      {
        id,
        question: question.title,
        ...(question.type === 'array' ? { multiSelect: true } : {}),
        ...(options.length ? { options } : {}),
      },
    ];
  });
}

/** Saved presentation fields only. Source/proof/permission/transport objects are never a body API. */
export function interactionEvidence(value: Json): Json {
  const saved = evidenceObject(value);
  const request =
    saved.request && typeof saved.request === 'object' && !Array.isArray(saved.request)
      ? saved.request
      : {};
  const answer =
    saved.answer && typeof saved.answer === 'object' && !Array.isArray(saved.answer)
      ? saved.answer
      : null;
  const publicAnswer: Record<string, Json> | null = answer
    ? strings(answer, ['kind', 'feedback', 'optionId'])
    : null;
  if (answer && publicAnswer) {
    if (['approve', 'deny', 'revise'].includes(String(answer.decision)))
      publicAnswer.decision = answer.decision!;
    if (answer.kind === 'question' && answer.answers !== undefined)
      publicAnswer.answers = answer.answers;
  }
  const questions = publicQuestions(request);
  const input = object(request.input);
  const action =
    saved.kind === 'approval' &&
    request.definitionId === 'shell.execute' &&
    request.definitionVersion === '1' &&
    typeof input?.command === 'string' &&
    input.command.length > 0
      ? {
          kind: 'shell',
          command: input.command,
          ...strings(input, ['workdir']),
          ...(['workspace_write', 'full_access'].includes(String(input.filesystem))
            ? { filesystem: input.filesystem! }
            : {}),
          ...(['none', 'internet'].includes(String(input.network))
            ? { network: input.network! }
            : {}),
        }
      : undefined;
  return {
    revision: typeof saved.revision === 'string' ? saved.revision : null,
    acceptedDecisionRevision:
      typeof saved.acceptedDecisionRevision === 'string' ? saved.acceptedDecisionRevision : null,
    request: {
      ...strings(request, [
        'title',
        'description',
        'prompt',
        'question',
        'content',
        'planId',
        'version',
      ]),
      ...(action ? { action } : {}),
      ...(questions.length ? { questions } : {}),
      ...(Array.isArray(request.options)
        ? { options: publicOptions(request.options, saved.kind === 'approval') }
        : {}),
    },
    answer: publicAnswer,
  };
}

/** Saved selection/compression boundaries only; assembled requests have private Model readers. */
export function contextEvidence(value: Json): Json {
  const saved = evidenceObject(value);
  const request =
    saved.request && typeof saved.request === 'object' && !Array.isArray(saved.request)
      ? saved.request
      : {};
  const selection: Record<string, Json> = strings(request, [
    'id',
    'sessionId',
    'previousSelectionId',
    'boundaryMessageId',
    'boundarySeq',
    'tailFromSeq',
  ]);
  if (Array.isArray(request.ranges))
    selection.ranges = request.ranges.map((range) =>
      strings(evidenceObject(range), ['afterSeq', 'throughSeq']),
    );
  const compression: Record<string, Json> = {};
  if (saved.kind === 'compression' || saved.kind === 'compression_pending')
    for (const name of ['coveredThroughSeq', 'publishedSeq']) {
      const parsed = decimal64Schema.safeParse(request[name]);
      if (parsed.success) compression[name] = parsed.data;
    }
  return {
    ...strings(saved, ['snapshotId', 'kind', 'selectionId']),
    selection,
    ...(Object.keys(compression).length ? { compression } : {}),
  };
}

export function toolResultEvidence(value: Json, presentation?: Json): Record<string, Json> {
  const saved = evidenceObject(value);
  const parsed = toolResultPresentationSchema.safeParse(presentation);
  return {
    outcome: ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(saved.outcome))
      ? saved.outcome!
      : 'outcome_unknown',
    content: typeof saved.content === 'string' ? saved.content : '',
    ...(parsed.success ? { presentation: parsed.data as unknown as Json } : {}),
  };
}

/** Original Files receipt only; this view never reads today's disk or computes a new diff. */
export function fileChangeEvidence(value: Json): Json | null {
  const item = evidenceObject(value);
  const baseline = (value: Json | undefined) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (
      typeof value.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.hash) ||
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.device !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(value.device) ||
      typeof value.inode !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(value.inode)
    )
      return null;
    return { hash: value.hash, size: value.size, device: value.device, inode: value.inode };
  };
  const after = baseline(item.after),
    before = item.before === null ? null : baseline(item.before);
  if (
    item.version !== 1 ||
    !['line_diff', 'file_content'].includes(String(item.format)) ||
    typeof item.path !== 'string' ||
    !item.path ||
    typeof item.text !== 'string' ||
    Buffer.byteLength(item.text) > 65536 ||
    Buffer.from(item.text).toString('utf8') !== item.text ||
    typeof item.truncated !== 'boolean' ||
    !after ||
    (item.before !== null && !before)
  )
    return null;
  return {
    version: 1,
    format: item.format!,
    path: item.path,
    before,
    after,
    text: item.text,
    truncated: item.truncated,
  };
}
