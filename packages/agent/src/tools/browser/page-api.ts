import type { Json, ToolDefinition } from '../../extensions';
import { AgentError } from '../../storage/types';
import type { BrowserController, BrowserControlOperation } from './types';

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const identity = { ...text(128), pattern: '^[A-Za-z0-9_.-]+$' };
const ref = { ...text(16), pattern: '^@?e[1-9][0-9]{0,12}$' };
const seq = { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' };
const object = (properties: Record<string, Json>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const browserPressKeyPattern =
  '^(?:(?:Control|Meta|Alt|Shift)\\+){0,3}(?:Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|[a-zA-Z0-9])$';

/** Fixed agent-browser 0.39.4 actions.rs: press/key, hover/selector,
 * select/selector+values, wait/text+timeout, and back/forward/reload.
 * https://github.com/vercel-labs/agent-browser/blob/04ba5264dade678062c3cdcce0f4f293e748249f/cli/src/native/actions.rs */
export function createBrowserControlTool(controller: BrowserController): ToolDefinition {
  return {
    id: 'browser.control',
    version: '1',
    model: { name: 'browser_control', hidden: true },
    description:
      'Internal exact-page operations for the isolated browser execution API. Every call independently passes the original Tool permission and cancellation gates. No raw selector, script or endpoint. Pointer coordinates require the exact formal image proof, and dialogs require the current host-issued identity.',
    inputSchema: object({
      browserId: identity,
      generation: identity,
      operation: {
        oneOf: [
          object({
            action: { enum: ['snapshot', 'capture', 'back', 'forward', 'reload', 'dialogs'] },
          }),
          object({
            action: { const: 'press' },
            key: { ...text(96), pattern: browserPressKeyPattern },
          }),
          object({ action: { const: 'hover' }, ref, seq }),
          object({
            action: { const: 'select' },
            ref,
            seq,
            values: {
              type: 'array',
              minItems: 1,
              maxItems: 16,
              items: { type: 'string', maxLength: 1024 },
            },
          }),
          object({
            action: { const: 'wait' },
            text: text(1024),
            timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
          }),
          object({
            action: { const: 'dialog' },
            dialogRef: identity,
            response: { enum: ['accept', 'dismiss'] },
          }),
          object({
            action: { const: 'pointer' },
            imageRef: identity,
            kind: { const: 'click' },
            from: object({
              x: { type: 'number', minimum: 0, maximum: 1920 },
              y: { type: 'number', minimum: 0, maximum: 1080 },
            }),
          }),
          object({
            action: { const: 'pointer' },
            imageRef: identity,
            kind: { const: 'drag' },
            from: object({
              x: { type: 'number', minimum: 0, maximum: 1920 },
              y: { type: 'number', minimum: 0, maximum: 1080 },
            }),
            to: object({
              x: { type: 'number', minimum: 0, maximum: 1920 },
              y: { type: 'number', minimum: 0, maximum: 1080 },
            }),
          }),
        ],
      },
    }),
    async execute(input, context) {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new AgentError('invalid_browser_arguments');
      if (!controller.control) return { outcome: 'failed', content: 'browser_control_unavailable' };
      return controller.control(
        context.sessionId,
        { browserId: String(input.browserId), generation: String(input.generation) },
        input.operation as unknown as BrowserControlOperation,
        context.signal,
      );
    },
  };
}
