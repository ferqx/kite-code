import Ajv from 'ajv';
import { workerEndpoint } from '../platform/process/worker-endpoint';

type SchemaPair = { input: object; output?: object };
type Request =
  | { id: number; kind: 'compile'; schemas: SchemaPair[] }
  | { id: number; kind: 'input' | 'output'; index: number; value: unknown };
const endpoint = workerEndpoint<Request, { id: number; valid?: boolean; error?: string }>();
let validators: { input: ReturnType<Ajv['compile']>; output?: ReturnType<Ajv['compile']> }[] = [];
endpoint.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'compile') {
      const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
      validators = data.schemas.map((schema) => {
        const output = schema.output ? ajv.compile(schema.output) : undefined;
        const input = ajv.compile(schema.input);
        return { input, output };
      });
      endpoint.postMessage({ id: data.id, valid: true });
    } else {
      const pair = validators[data.index];
      if (!pair) throw new Error('schema_identity_invalid');
      const validate = data.kind === 'input' ? pair.input : pair.output;
      if (!validate) endpoint.postMessage({ id: data.id, valid: true });
      else if ('$async' in validate && validate.$async) {
        await validate(data.value);
        endpoint.postMessage({ id: data.id, valid: true });
      } else endpoint.postMessage({ id: data.id, valid: !!validate(data.value) });
    }
  } catch {
    endpoint.postMessage(
      data.kind === 'compile'
        ? { id: data.id, error: 'mcp_arguments_invalid' }
        : { id: data.id, valid: false },
    );
  }
};
