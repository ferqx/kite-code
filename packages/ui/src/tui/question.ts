import { ComposerBuffer } from './composer';

type Choice = { value: unknown; title: string; description?: string };
export type QuestionField = {
  key?: string;
  title?: string;
  description?: string;
  choices: Choice[];
  text: boolean;
  required: boolean;
  minLength?: number;
  maxLength?: number;
};
export type QuestionForm = {
  title?: string;
  description?: string;
  object: boolean;
  fields: QuestionField[];
};
export type QuestionDraft = {
  step: number;
  fields: { selected?: number; buffer: ComposerBuffer; skipped?: boolean }[];
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const metadata = ['title', 'description'];
const simple = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
function field(schema: unknown, required: boolean, key?: string): QuestionField | undefined {
  if (
    !record(schema) ||
    Object.keys(schema).some(
      (k) =>
        ![
          ...metadata,
          'type',
          'enum',
          'const',
          'oneOf',
          'anyOf',
          'minLength',
          'maxLength',
        ].includes(k),
    )
  )
    return;
  if (['const', 'enum', 'oneOf', 'anyOf'].filter((k) => k in schema).length > 1) return;
  if ('const' in schema && !simple(schema.const)) return;
  if (
    'enum' in schema &&
    (!Array.isArray(schema.enum) || !schema.enum.length || !schema.enum.every(simple))
  )
    return;
  for (const keyword of ['oneOf', 'anyOf']) {
    if (
      keyword in schema &&
      (!Array.isArray(schema[keyword]) || !(schema[keyword] as unknown[]).length)
    )
      return;
  }
  for (const bound of ['minLength', 'maxLength']) {
    if (
      bound in schema &&
      (typeof schema[bound] !== 'number' ||
        !Number.isSafeInteger(schema[bound]) ||
        (schema[bound] as number) < 0)
    )
      return;
  }
  const minLength = schema.minLength as number | undefined;
  const maxLength = schema.maxLength as number | undefined;
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return;
  const lengthValid = (value: unknown) =>
    typeof value !== 'string' ||
    ((minLength === undefined || Array.from(value).length >= minLength) &&
      (maxLength === undefined || Array.from(value).length <= maxLength));
  const compatible = (value: unknown) =>
    schema.type === undefined ||
    (schema.type === 'null'
      ? value === null
      : schema.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : typeof value === schema.type);
  if ('const' in schema && (!compatible(schema.const) || !lengthValid(schema.const))) return;
  if (Array.isArray(schema.enum) && !schema.enum.every((v) => compatible(v) && lengthValid(v)))
    return;
  const base = {
    key,
    title: text(schema.title) ?? key,
    description: text(schema.description),
    required,
    minLength,
    maxLength,
  };
  if ('const' in schema && simple(schema.const))
    return {
      ...base,
      text: false,
      choices: [
        {
          value: schema.const,
          title: text(schema.title) ?? String(schema.const),
          description: text(schema.description),
        },
      ],
    };
  if (
    Array.isArray(schema.enum) &&
    new Set(schema.enum.map((v) => JSON.stringify(v))).size !== schema.enum.length
  )
    return;
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.every(simple))
    return {
      ...base,
      text: false,
      choices: schema.enum.map((value) => ({ value, title: String(value) })),
    };
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length) {
    const choices: Choice[] = [];
    let free = false;
    for (const branch of union) {
      if (!record(branch) || 'oneOf' in branch || 'anyOf' in branch) return;
      const parsed = field(branch, required, key);
      if (!parsed) return;
      if (parsed.text) {
        if (
          free ||
          parsed.minLength !== undefined ||
          parsed.maxLength !== undefined ||
          schema.oneOf
        )
          return;
        free = true;
      }
      choices.push(...parsed.choices);
    }
    if (new Set(choices.map((c) => JSON.stringify(c.value))).size !== choices.length) return;
    if (
      !choices.every((c) => compatible(c.value) && lengthValid(c.value)) ||
      (free && schema.type !== undefined && schema.type !== 'string')
    )
      return;
    return { ...base, text: free, choices };
  }
  if (schema.type === 'string') return { ...base, text: true, choices: [] };
  return undefined;
}
/** Conservative presentation of the original JSON Schema. Unhandled validation stays in the JSON panel. */
export function questionForm(request: unknown): QuestionForm | undefined {
  if (!record(request) || !record(request.schema)) return;
  const schema = request.schema;
  if (schema.type !== 'object') {
    const parsed = field(schema, true);
    return parsed ? { object: false, fields: [parsed] } : undefined;
  }
  if (
    Object.keys(schema).some(
      (k) => ![...metadata, 'type', 'properties', 'required', 'additionalProperties'].includes(k),
    ) ||
    !record(schema.properties)
  )
    return;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
    return;
  const properties = schema.properties;
  // Core rejects this key because its JSON Schema validator cannot faithfully validate it.
  if (Object.hasOwn(properties, '__proto__')) return;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some(
      (k) => typeof k !== 'string' || k === '__proto__' || !Object.hasOwn(properties, k),
    )
  )
    return;
  const fields: QuestionField[] = [];
  for (const [key, value] of Object.entries(schema.properties)) {
    const parsed = field(value, required.includes(key), key);
    if (!parsed) return;
    fields.push(parsed);
  }
  if (!fields.length) return;
  return { title: text(schema.title), description: text(schema.description), object: true, fields };
}
export function questionDraft(form: QuestionForm): QuestionDraft {
  return { step: 0, fields: form.fields.map(() => ({ buffer: new ComposerBuffer() })) };
}
export function questionValue(
  field: QuestionField,
  draft: QuestionDraft['fields'][number],
): { value: unknown } | undefined {
  if (draft.skipped && !field.required) return { value: undefined };
  if (draft.selected !== undefined && draft.selected < field.choices.length)
    return { value: field.choices[draft.selected]!.value };
  if (
    field.text &&
    (!field.choices.length || draft.selected === field.choices.length) &&
    draft.buffer.text.trim() &&
    !questionLengthError(field, draft.buffer.text)
  )
    return { value: draft.buffer.text };
  return undefined;
}
export function questionAnswer(form: QuestionForm, draft: QuestionDraft): string | undefined {
  const values = form.fields.map((field, i) => questionValue(field, draft.fields[i]!));
  if (values.some((v) => !v)) return;
  return JSON.stringify(
    form.object
      ? Object.fromEntries(
          form.fields.flatMap((field, i) =>
            values[i]!.value === undefined ? [] : [[field.key!, values[i]!.value]],
          ),
        )
      : values[0]!.value,
  );
}

/** JSON Schema string bounds count Unicode code points, while the editor moves graphemes. */
export function questionLengthError(
  field: QuestionField,
  value: string,
): { kind: 'minimum' | 'maximum'; bound: number; length: number } | undefined {
  const length = Array.from(value).length;
  if (field.minLength !== undefined && length < field.minLength)
    return { kind: 'minimum', bound: field.minLength, length };
  if (field.maxLength !== undefined && length > field.maxLength)
    return { kind: 'maximum', bound: field.maxLength, length };
  return undefined;
}
