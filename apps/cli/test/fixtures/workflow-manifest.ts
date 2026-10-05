/** A real no-effect Workflow contract for owned loopback CLI fixtures. */
export function workflowManifest(name: string, structuredInput = false) {
  return {
    name,
    version: '1.0.0',
    description: 'explicit CLI Workflow',
    invocation: { allow_manual: true, allow_implicit: false },
    context: { mode: 'inline', agent: 'code' },
    input_schema: {
      type: 'object',
      additionalProperties: false,
      ...(structuredInput
        ? { properties: { required: { type: 'string' } }, required: ['required'] }
        : {}),
    },
    output_schema: { type: 'object', additionalProperties: false },
    capabilities: { require: [], deny: [] },
    effects: { filesystem: 'none', network: 'none', external_state: 'none' },
    approval: { minimum: 'none' },
    execution: { timeout_ms: 5000, max_attempts: 1 },
    verification: { mode: 'not_required' },
    recovery: { retry: 'never' },
  };
}
