type Choice = { value: unknown; title: string; description?: string };
export type QuestionField = {
  key?: string;
  title?: string;
  description?: string;
  choices: Choice[];
  text: boolean;
  /** Original closed single-property object used by an explicit custom-text branch. */
  textKey?: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
};
export type QuestionForm = {
  title?: string;
  description?: string;
  object: boolean;
  fields: QuestionField[];
  alternative?: Choice;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const metadata = ['title', 'description'];
const simple = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
function field(schema: unknown, required: boolean, key?: string): QuestionField | undefined {
  if (record(schema) && schema.type === 'object') {
    if (
      Object.keys(schema).some(
        (k) => ![...metadata, 'type', 'properties', 'required', 'additionalProperties'].includes(k),
      ) ||
      schema.additionalProperties !== false ||
      !record(schema.properties)
    )
      return;
    const entries = Object.entries(schema.properties);
    if (entries.length !== 1) return;
    const [textKey, textSchema] = entries[0]!;
    if (
      textKey === '__proto__' ||
      !Array.isArray(schema.required) ||
      schema.required.length !== 1 ||
      schema.required[0] !== textKey ||
      !record(textSchema) ||
      textSchema.type !== 'string'
    )
      return;
    const parsed = field(textSchema, true);
    if (!parsed?.text || parsed.choices.length || parsed.textKey !== undefined) return;
    return {
      ...parsed,
      key,
      title: text(schema.title) ?? key,
      description: text(schema.description),
      required,
      textKey,
    };
  }
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
          'pattern',
        ].includes(k),
    )
  )
    return;
  if ('pattern' in schema && schema.pattern !== '\\S') return;
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
    ((schema.pattern === undefined || value.trim().length > 0) &&
      (minLength === undefined || Array.from(value).length >= minLength) &&
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
    let free: QuestionField | undefined;
    for (const branch of union) {
      if (!record(branch) || 'oneOf' in branch || 'anyOf' in branch) return;
      const parsed = field(branch, required, key);
      if (!parsed) return;
      if (parsed.text) {
        if (
          free ||
          (parsed.textKey === undefined &&
            (parsed.minLength !== undefined || parsed.maxLength !== undefined)) ||
          schema.oneOf
        )
          return;
        free = parsed;
      }
      choices.push(...parsed.choices);
    }
    if (new Set(choices.map((c) => JSON.stringify(c.value))).size !== choices.length) return;
    if (
      !choices.every((c) => compatible(c.value) && lengthValid(c.value)) ||
      (free &&
        schema.type !== undefined &&
        schema.type !== (free.textKey === undefined ? 'string' : 'object'))
    )
      return;
    return {
      ...base,
      text: free !== undefined,
      choices,
      textKey: free?.textKey,
      minLength: free?.textKey === undefined ? minLength : free.minLength,
      maxLength: free?.textKey === undefined ? maxLength : free.maxLength,
    };
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
    if (parsed) return { object: false, fields: [parsed] };
    // A closed shallow questionnaire and its explicit null alternative are
    // disjoint. Keep all other root unions in the original JSON panel.
    if (
      Object.keys(schema).some((key) => ![...metadata, 'oneOf'].includes(key)) ||
      !Array.isArray(schema.oneOf) ||
      schema.oneOf.length !== 2
    )
      return;
    const object = schema.oneOf.find((branch) => record(branch) && branch.type === 'object');
    const alternate = schema.oneOf.find(
      (branch) => record(branch) && Object.hasOwn(branch, 'const') && branch.const === null,
    );
    if (!record(object) || object.additionalProperties !== false || !alternate) return;
    const form = questionForm({ schema: object });
    const choice = field(alternate, true);
    if (!form?.object || choice?.text || choice?.choices.length !== 1) return;
    return {
      ...form,
      title: text(schema.title) ?? form.title,
      description: text(schema.description) ?? form.description,
      alternative: choice.choices[0],
    };
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

export type QuestionFieldDraft = { selected?: number; text: string; skipped?: boolean };
export function questionFieldValue(
  field: QuestionField,
  draft: QuestionFieldDraft,
): { value: unknown } | undefined {
  if (draft.skipped && !field.required) return { value: undefined };
  if (draft.selected !== undefined) {
    const choice = field.choices[draft.selected];
    if (choice) return { value: choice.value };
  }
  if (
    field.text &&
    (!field.choices.length || draft.selected === field.choices.length) &&
    draft.text.trim() &&
    !questionLengthError(field, draft.text)
  )
    return { value: field.textKey === undefined ? draft.text : { [field.textKey]: draft.text } };
  return undefined;
}
export function questionValues(
  form: QuestionForm,
  drafts: readonly QuestionFieldDraft[],
): { value: unknown } | undefined {
  const values = form.fields.map((field, i) =>
    questionFieldValue(field, drafts[i] ?? { text: '' }),
  );
  if (values.some((v) => !v)) return;
  return {
    value: form.object
      ? Object.fromEntries(
          form.fields.flatMap((field, i) =>
            values[i]!.value === undefined ? [] : [[field.key!, values[i]!.value]],
          ),
        )
      : values[0]!.value,
  };
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
