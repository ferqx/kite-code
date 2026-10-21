import Ajv from 'ajv';

type SchemaPair = { input: object; output?: object };
type Request =
  | { id: number; kind: 'compile'; schemas: SchemaPair[] }
  | { id: number; kind: 'input' | 'output'; index: number; value: unknown };
declare const self: {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(value: { id: number; valid?: boolean; error?: string }): void;
};
let validators: { input: ReturnType<Ajv['compile']>; output?: ReturnType<Ajv['compile']> }[] = [];
self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'compile') {
      const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
      validators = data.schemas.map((schema) => {
        const output = schema.output ? ajv.compile(schema.output) : undefined;
        const input = ajv.compile(schema.input);
        return { input, output };
      });
      self.postMessage({ id: data.id, valid: true });
    } else {
      const pair = validators[data.index];
      if (!pair) throw new Error('schema_identity_invalid');
      const validate = data.kind === 'input' ? pair.input : pair.output;
      if (!validate) self.postMessage({ id: data.id, valid: true });
      else if ('$async' in validate && validate.$async) {
        await validate(data.value);
        self.postMessage({ id: data.id, valid: true });
      } else self.postMessage({ id: data.id, valid: !!validate(data.value) });
    }
  } catch {
    self.postMessage(
      data.kind === 'compile'
        ? { id: data.id, error: 'mcp_arguments_invalid' }
        : { id: data.id, valid: false },
    );
  }
};
