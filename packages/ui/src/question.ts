type Choice = { value: unknown; title: string; description?: string; recommended?: boolean };
export type QuestionField = {
  key?: string;
  title?: string;
  description?: string;
  choices: Choice[];
  multiple?: true;
  text: boolean;
  /** Text property of the original closed custom answer object. */
  textKey?: string;
  /** The custom-text object also permits the same array of choice IDs. */
  textWithChoices?: true;
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
  if (record(schema) && schema.type === 'array') {
    if (
      Object.keys(schema).some(
        (name) =>
          ![...metadata, 'type', 'items', 'minItems', 'maxItems', 'uniqueItems'].includes(name),
      ) ||
      !record(schema.items) ||
      schema.items.type !== 'string' ||
      schema.minItems !== 1 ||
      schema.uniqueItems !== true
    )
      return;
    const items = field(schema.items, true);
    if (!items?.choices.length || items.text || schema.maxItems !== items.choices.length) return;
    return {
      key,
      title: text(schema.title) ?? key,
      description: text(schema.description),
      required,
      choices: items.choices,
      multiple: true,
      text: false,
    };
  }
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
    let multiple: QuestionField | undefined;
    let customChoices: QuestionField | undefined;
    for (const branch of union) {
      if (!record(branch) || 'oneOf' in branch || 'anyOf' in branch) return;
      let candidate = branch;
      if (
        branch.type === 'object' &&
        record(branch.properties) &&
        Object.hasOwn(branch.properties, 'choices') &&
        Object.keys(branch.properties).length > 1
      ) {
        if (customChoices) return;
        const { choices, ...properties } = branch.properties;
        customChoices = field(choices, true);
        if (!customChoices?.multiple) return;
        candidate = { ...branch, properties };
      }
      const parsed = field(candidate, required, key);
      if (!parsed) return;
      if (parsed.multiple) {
        if (multiple) return;
        multiple = parsed;
      }
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
    if (
      multiple &&
      (schema.type !== undefined ||
        choices.length !== multiple.choices.length ||
        (free && free.textKey === undefined))
    )
      return;
    if (
      customChoices &&
      (!multiple ||
        customChoices.choices.length !== choices.length ||
        customChoices.choices.some((choice, index) => choice.value !== choices[index]?.value))
    )
      return;
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
      ...(multiple ? { multiple: true as const } : {}),
      textKey: free?.textKey,
      ...(customChoices ? { textWithChoices: true as const } : {}),
      minLength: free?.textKey === undefined ? minLength : free.minLength,
      maxLength: free?.textKey === undefined ? maxLength : free.maxLength,
    };
  }
  if (schema.type === 'string') return { ...base, text: true, choices: [] };
  return undefined;
}
/** Conservative presentation of the original JSON Schema. Unhandled validation stays in the JSON panel. */
export function questionForm(request: unknown, askUser = false): QuestionForm | undefined {
  if (!record(request) || !record(request.schema)) return;
  const schema = request.schema;
  const { recommendedOptions } = request;
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
    const form = questionForm({ schema: object, recommendedOptions }, askUser);
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
    const recommended =
      record(recommendedOptions) && Object.hasOwn(recommendedOptions, key)
        ? text(recommendedOptions[key])
        : undefined;
    if (recommended !== undefined) {
      const choice = parsed.choices.find(({ value }) => value === recommended);
      if (choice) choice.recommended = true;
    } else if (askUser && recommendedOptions === undefined) {
      // Earlier ask_user requests appended this marker to the first option automatically.
      const first = parsed.choices[0];
      if (first?.value === `${key}-o1` && first.title.endsWith(' (Recommended)'))
        first.title = first.title.slice(0, -' (Recommended)'.length);
    }
    fields.push(parsed);
  }
  if (!fields.length) return;
  return { title: text(schema.title), description: text(schema.description), object: true, fields };
}

export type QuestionFieldDraft = {
  selected?: number;
  selectedChoices?: readonly number[];
  text: string;
  skipped?: boolean;
};
export function toggleQuestionChoice(selected: readonly number[] = [], index: number): number[] {
  return selected.includes(index)
    ? selected.filter((choice) => choice !== index)
    : [...selected, index].sort((left, right) => left - right);
}
export function questionFieldValue(
  field: QuestionField,
  draft: QuestionFieldDraft,
): { value: unknown } | undefined {
  if (draft.skipped && !field.required) return { value: undefined };
  const custom = field.text && (!field.choices.length || draft.selected === field.choices.length);
  const validText = custom && draft.text.trim() && !questionLengthError(field, draft.text);
  if (field.multiple) {
    const selected = draft.selectedChoices ?? [];
    if (new Set(selected).size !== selected.length) return;
    const choices = selected.map((index) => field.choices[index]);
    if (choices.some((choice) => choice === undefined)) return;
    const values = choices.map((choice) => choice!.value);
    if (!custom) return values.length ? { value: values } : undefined;
    if (!validText || field.textKey === undefined) return;
    return {
      value: {
        [field.textKey]: draft.text,
        ...(field.textWithChoices && values.length ? { choices: values } : {}),
      },
    };
  }
  if (draft.selected !== undefined) {
    const choice = field.choices[draft.selected];
    if (choice) return { value: choice.value };
  }
  if (validText)
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
