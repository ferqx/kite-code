import type { ActionDefinition, Json, PermissionDecision } from '../extensions';
import { AgentError, type CommandRecord } from '../storage/types';

type Revocation = 'handoff' | 'close' | 'human-stop';
const registrations = new WeakMap<object, Revocation>();
type SessionSource = { readonly executionId: string; readonly signal: AbortSignal };
type ContinuationSource = { readonly signal: AbortSignal; readonly purpose: Json } & (
  | { readonly runId: string }
  | { readonly executionId: string }
);
const browserSessions = new WeakMap<
  object,
  (
    sessionId: string,
    target: { browserId: string; generation: string },
  ) => SessionSource | undefined
>();
/** The real controller registers its exact Job context, without adding a public controller capability. */
export function registerBrowserSessionSource(
  controller: object,
  read: (
    sessionId: string,
    target: { browserId: string; generation: string },
  ) => SessionSource | undefined,
): void {
  browserSessions.set(controller, read);
}
export function browserSessionSource(
  controller: object,
  sessionId: string,
  target: { browserId: string; generation: string },
): SessionSource | undefined {
  return browserSessions.get(controller)?.(sessionId, target);
}
const continuations = new WeakMap<
  object,
  (command: CommandRecord) => Promise<ContinuationSource | undefined>
>();

/** A trusted original-request lookup selects a reviewer, never an authorization grant. */
export function sealBrowserContinuationAction(
  definition: ActionDefinition,
  resolve: (command: CommandRecord) => Promise<ContinuationSource | undefined>,
): ActionDefinition {
  if (
    !['browser.respond_human', 'browser.resume'].includes(definition.id) ||
    definition.version !== '1' ||
    definition.runControl !== true ||
    definition.resources !== undefined
  )
    throw new AgentError('invalid_browser_continuation_action');
  const sealed = Object.freeze({ ...definition });
  continuations.set(sealed, resolve);
  return sealed;
}
export async function browserContinuationSource(
  definition: ActionDefinition,
  command: CommandRecord,
): Promise<ContinuationSource | undefined> {
  const resolve = Object.isFrozen(definition) ? continuations.get(definition) : undefined;
  if (!resolve) return undefined;
  freezeInput(command.request);
  return resolve(command);
}

/** Internal builtin registration only; never exported through the extension API. */
export function sealBrowserRevocationAction(
  definition: ActionDefinition,
  kind: Revocation,
): ActionDefinition {
  const id = kind === 'human-stop' ? 'browser.respond_human' : `browser.${kind}`;
  if (
    definition.id !== id ||
    definition.version !== '1' ||
    definition.runControl !== true ||
    definition.resources !== undefined
  )
    throw Error('invalid_host_revocation_action');
  const sealed = Object.freeze({ ...definition });
  registrations.set(sealed, kind);
  inheritHostRevocation(definition, sealed);
  return sealed;
}

/** Called only by Core's definition sealing, never inferred from a name or flag. */
export function inheritHostRevocation(source: object, sealed: object): void {
  const kind = Object.isFrozen(source) ? registrations.get(source) : undefined;
  if (kind && Object.isFrozen(sealed)) registrations.set(sealed, kind);
  const continuation = Object.isFrozen(source) ? continuations.get(source) : undefined;
  if (continuation && Object.isFrozen(sealed)) continuations.set(sealed, continuation);
}

function freezeInput(input: Json): void {
  if (input && typeof input === 'object') {
    for (const value of Object.values(input)) freezeInput(value);
    if (!Object.isFrozen(input)) Object.freeze(input);
  }
}

/** Only an exact registered revocation with a valid bounded target may use
 * reserved control capacity. This grants neither a page nor dispatch authority. */
export function isBrowserRevocation(definition: ActionDefinition, input: Json): boolean {
  const kind = Object.isFrozen(definition) ? registrations.get(definition) : undefined;
  if (!kind || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const keys =
    kind === 'human-stop'
      ? ['browserId', 'generation', 'requestId', 'expectedRevision', 'choice']
      : ['browserId', 'generation'];
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)))
    return false;
  if (kind === 'human-stop') {
    if (
      input.choice !== 'stop' ||
      typeof input.requestId !== 'string' ||
      !input.requestId.length ||
      input.requestId.length > 128 ||
      typeof input.expectedRevision !== 'string' ||
      !/^[1-9][0-9]*$/.test(input.expectedRevision)
    )
      return false;
  }
  if (
    ![input.browserId, input.generation].every(
      (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value),
    )
  )
    return false;
  freezeInput(input);
  return true;
}

/** Queue interruption is narrower than dispatch authority: only an exact
 * builtin revocation may cancel a not-yet-dispatched continuation of its page. */
export function interruptsBrowserContinuation(
  definition: ActionDefinition,
  input: Json,
  previous: { actionId: string; input: Json },
): boolean {
  if (!isBrowserRevocation(definition, input)) return false;
  const kind = registrations.get(definition)!;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const prior = previous.input;
  if (
    !prior ||
    typeof prior !== 'object' ||
    Array.isArray(prior) ||
    input.browserId !== prior.browserId ||
    input.generation !== prior.generation
  )
    return false;
  const matches =
    previous.actionId === 'browser.resume'
      ? kind !== 'human-stop'
      : previous.actionId === 'browser.respond_human' &&
        prior.choice === 'continue' &&
        (kind !== 'human-stop' ||
          (input.requestId === prior.requestId &&
            input.expectedRevision === prior.expectedRevision));
  if (matches) freezeInput(input);
  return matches;
}

/** Pin prepared input before the first await so stop cannot become continue later. */
export function hostRevocationAuthorization(
  definition: ActionDefinition,
  input: Json,
): PermissionDecision | undefined {
  const kind = Object.isFrozen(definition) ? registrations.get(definition) : undefined;
  if (
    !kind ||
    (kind === 'human-stop' &&
      (!input || typeof input !== 'object' || Array.isArray(input) || input.choice !== 'stop'))
  )
    return undefined;
  freezeInput(input);
  return {
    allowed: true,
    revision: 'builtin-browser-host-revocation',
    snapshot: {
      namespace: 'agent.host-revocation',
      version: '1',
      data: { kind },
    },
  };
}
