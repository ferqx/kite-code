export interface InputField {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
  readonly choices?: readonly string[];
}
export type FormDescription =
  | { readonly kind: 'fields'; readonly fields: readonly InputField[] }
  | { readonly kind: 'raw-json'; readonly reason: string };
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Describe only the supported subset. JSON remains available for every other shape. */
export function describeInput(schema: unknown): FormDescription {
  const shape = record(schema);
  if (
    shape?.type !== 'object' ||
    !record(shape.properties) ||
    Object.keys(shape).some(
      (key) =>
        ![
          'type',
          'properties',
          'required',
          'additionalProperties',
          'title',
          'description',
          '$schema',
        ].includes(key),
    ) ||
    shape.additionalProperties !== false
  )
    return { kind: 'raw-json', reason: 'This input schema requires raw JSON.' };
  const required = Array.isArray(shape.required) ? shape.required : [];
  const fields: InputField[] = [];
  for (const [name, definition] of Object.entries(record(shape.properties)!)) {
    const property = record(definition);
    if (
      !property ||
      Object.keys(property).some(
        (key) =>
          ![
            'type',
            'enum',
            'title',
            'description',
            'minLength',
            'maxLength',
            'minimum',
            'maximum',
            'pattern',
            'default',
          ].includes(key),
      )
    )
      return { kind: 'raw-json', reason: 'This input schema requires raw JSON.' };
    if (property.enum !== undefined) {
      if (!Array.isArray(property.enum) || !property.enum.every((item) => typeof item === 'string'))
        return { kind: 'raw-json', reason: 'This enumeration requires raw JSON.' };
      fields.push({
        name,
        label: typeof property.title === 'string' ? property.title : name,
        required: required.includes(name),
        kind: 'enum',
        choices: property.enum,
      });
    } else {
      const kind = property.type;
      if (kind !== 'string' && kind !== 'number' && kind !== 'integer' && kind !== 'boolean')
        return { kind: 'raw-json', reason: 'Nested or unknown inputs require raw JSON.' };
      fields.push({
        name,
        label: typeof property.title === 'string' ? property.title : name,
        required: required.includes(name),
        kind,
      });
    }
  }
  return { kind: 'fields', fields };
}
export function serializeInput(
  form: FormDescription,
  values: Readonly<Record<string, string | boolean>>,
  initial: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  if (form.kind !== 'fields') throw new Error('raw_json_required');
  const result = { ...initial };
  for (const field of form.fields) {
    const value = values[field.name];
    if (value === undefined && field.required) throw new Error(`Input required: ${field.label}`);
    if (value === undefined || (value === '' && !field.required)) {
      delete result[field.name];
      continue;
    }
    if (field.required && value === '') throw new Error(`Input required: ${field.label}`);
    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Invalid boolean: ${field.label}`);
      result[field.name] = value;
    } else if (field.kind === 'number' || field.kind === 'integer') {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
      if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isSafeInteger(number)))
        throw new Error(`Invalid number: ${field.label}`);
      result[field.name] = number;
    } else {
      if (typeof value !== 'string' || (field.kind === 'enum' && !field.choices?.includes(value)))
        throw new Error(`Invalid value: ${field.label}`);
      result[field.name] = value;
    }
  }
  return result;
}
