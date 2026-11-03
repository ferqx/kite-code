import { randomUUID } from 'node:crypto';
import type { BrowserDecoration } from './browser-decoration';
import {
  type BrowserControlLease,
  type BrowserCursor,
  BrowserPageLease,
  type BrowserPageScope,
} from './browser-lease';

export interface BrowserPageFailure {
  readonly kind: 'not_dispatched' | 'read_failed' | 'effect_unknown';
  readonly op: string;
  readonly leaseId?: string;
  readonly method?: string;
}
const localErrors = new WeakSet<Error>();
const failures = new WeakMap<object, BrowserPageFailure>();
const unsentPreflights = new WeakMap<Error, { pageId: string; method: string }>();
/** Main-only evidence: Native's fixed preflight failed before invoking the requested CDP method. */
export class BrowserPagePreflightError extends Error {
  constructor(
    pageId: string,
    method: 'Runtime.evaluate' | 'Runtime.callFunctionOn',
    kind: 'stale' | 'failed',
    cause?: unknown,
  ) {
    super(kind === 'stale' ? 'browser_page_read_stale' : 'browser_page_preflight_failed', {
      cause,
    });
    localErrors.add(this);
    unsentPreflights.set(this, { pageId, method });
  }
}
function hostError(code: string) {
  const error = Error(code);
  localErrors.add(error);
  return error;
}
function failureBinding(input: Record<string, unknown>) {
  return {
    op: String(input.op),
    ...(typeof input.leaseId === 'string' ? { leaseId: input.leaseId } : {}),
    ...(input.op === 'cdp' && typeof input.method === 'string' ? { method: input.method } : {}),
  };
}
/** Only errors created at this Host's dispatch boundary carry a private proof. */
export function serializeBrowserPageFailure(
  error: unknown,
  input: unknown,
): BrowserPageFailure | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    return;
  const proof = failures.get(error),
    binding = failureBinding(input as Record<string, unknown>);
  if (
    proof &&
    proof.op === binding.op &&
    proof.leaseId === binding.leaseId &&
    proof.method === binding.method
  )
    return { ...proof };
  return undefined;
}
type DispatchBoundary = { kind: BrowserPageFailure['kind'] };
const readMethods = new Set([
  'Browser.getVersion',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Runtime.getProperties',
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getBoxModel',
  'DOM.getNodeForLocation',
  'DOM.querySelector',
  'DOM.querySelectorAll',
]);

export interface BrowserPagePort {
  readonly id: string;
  readonly scope: BrowserPageScope;
  attach(): void | Promise<void>;
  detach(): boolean | Promise<boolean>;
  alive(): boolean;
  waitForDocument?(signal?: AbortSignal): Promise<boolean>;
  navigate?(
    url: string,
    signal: AbortSignal | undefined,
    beforeDispatch: () => void,
  ): Promise<{ navigation: number; current(): boolean }>;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  typingCursor(): Promise<{ x: number; y: number } | null>;
  onEvent(listener: (method: string, params: unknown, sessionId?: string) => void): () => void;
  decorate(value: BrowserDecoration): void;
  capture(): Promise<unknown>;
  captureMeta(): unknown;
  validateCapture?(captureId: string): Promise<boolean>;
  changed(): void;
}
type Page = {
  port: BrowserPagePort;
  control: BrowserPageLease;
  lease: BrowserControlLease | null;
  events: { seq: number; method: string; params: unknown }[];
  sequence: number;
  unwatch?: () => void;
  visible: boolean;
  grantReservation?: string;
  consumedCapture?: string;
  invalidCapture?: string;
  dialog?: {
    dialogRef: string;
    type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
    lease: BrowserControlLease;
    navigation: number;
  };
  pressed?: { x: number; y: number; lease: BrowserControlLease; navigation: number };
  pointerBusy?: boolean;
  acquiredBefore?: true;
};
export interface BrowserGrantScope extends BrowserPageScope {
  generation: number;
  viewSelection: number;
}
export interface BrowserGrantContext {
  selectedScope(): BrowserGrantScope | undefined;
  create(id: string, scope: BrowserPageScope): void | Promise<void>;
  describe(id: string): { title: string; url: string } | undefined;
  close(id: string): void;
}
type GrantState = 'question' | 'ready' | 'committed' | 'cancelled' | 'expired';
type Grant = {
  requestId: string;
  storeId: string;
  sessionId: string;
  executionId: string;
  browserId: string;
  url: string;
  requireExisting?: true;
  existingPage?: { pageId: string; incarnation: string };
  state: GrantState;
  page: { kind: 'existing' | 'new'; id?: string; title: string; url: string };
  selection?: BrowserGrantScope;
  binding?: { page: Page; incarnation: string; epoch: number; navigation: number };
  expiresAt: number;
  consumed: boolean;
  creating?: boolean;
  creation?: Promise<void>;
  initializing?: { page: Page; epoch: number };
  receipt?:
    | { interactionId: string; decisionRevision: string }
    | { executionId: string; authorizationDigest: string };
  timer?: ReturnType<typeof setTimeout>;
};
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
const methods = new Set([
  'Browser.getVersion',
  'Page.enable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.navigate',
  'Page.reload',
  'Page.stopLoading',
  'Page.setLifecycleEventsEnabled',
  'Page.createIsolatedWorld',
  'Page.captureScreenshot',
  'Runtime.enable',
  'Runtime.runIfWaitingForDebugger',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getBoxModel',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.getNodeForLocation',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.focus',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Input.dispatchTouchEvent',
  'Network.enable',
  'Network.setCacheDisabled',
  'Emulation.setFocusEmulationEnabled',
]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw hostError('page_request_invalid');
  return value as Record<string, unknown>;
}
function http(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function sameUrl(left: unknown, right: string) {
  return http(left) && new URL(left as string).href === new URL(right).href;
}
/** Only the Main-owned private Service channel calls this host; no renderer endpoint/target/JS input. */
export class NativeBrowserPageHost {
  private readonly pages = new Map<string, Page>();
  private readonly leases = new Map<string, Page>();
  private readonly retiredLeases = new Map<string, { page: Page; lease: BrowserControlLease }>();
  private readonly grants = new Map<string, Grant>();
  // A request's UUIDv7 timestamp fixes its lifetime even after its tombstone is reclaimed.
  private grantClock = Date.now();
  private grantNow() {
    this.grantClock = Math.max(this.grantClock, Date.now());
    return this.grantClock;
  }
  private grantContext?: BrowserGrantContext;
  configureGrantContext(context: BrowserGrantContext) {
    if (this.grantContext)
      for (const grant of this.grants.values()) this.endGrant(grant, 'expired');
    this.grantContext = context;
    return () => {
      if (this.grantContext !== context) return;
      for (const grant of this.grants.values()) this.endGrant(grant, 'expired');
      this.grantContext = undefined;
    };
  }
  assertCanCreate() {
    for (const grant of this.grants.values()) this.refreshGrant(grant);
    const reserved = [...this.grants.values()].filter(
      (grant) =>
        grant.state === 'question' &&
        grant.page.kind === 'new' &&
        !grant.binding &&
        !grant.creating,
    ).length;
    if (this.pages.size + reserved >= 8) throw hostError('browser_page_capacity');
  }
  private grantResult(grant: Grant) {
    return {
      requestId: grant.requestId,
      state: grant.state,
      page: { ...grant.page },
      url: grant.url,
      ...(grant.requireExisting ? { requireExisting: true } : {}),
      ...(grant.existingPage ? { existingPage: { ...grant.existingPage } } : {}),
      expiresAt: grant.expiresAt,
      consumed: grant.consumed,
    };
  }
  private endGrant(grant: Grant, state: 'cancelled' | 'expired') {
    if (grant.consumed) return;
    if (!['cancelled', 'expired'].includes(grant.state)) grant.state = state;
    clearTimeout(grant.timer);
    const bound = grant.binding,
      page = bound?.page;
    if (!page || !bound) {
      const initializing = grant.initializing;
      if (
        initializing &&
        this.pages.get(initializing.page.port.id) === initializing.page &&
        initializing.page.control.phase === 'human' &&
        !initializing.page.control.retained &&
        initializing.page.control.grantEpoch === initializing.epoch &&
        this.grantContext?.describe(initializing.page.port.id)?.url === ''
      )
        this.grantContext.close(initializing.page.port.id);
      return;
    }
    if (page.grantReservation === grant.requestId) page.grantReservation = undefined;
    const owns =
      page.control.grantSource === grant.requestId && page.control.grantEpoch === bound.epoch;
    const close =
      owns &&
      grant.page.kind === 'new' &&
      page.control.navigation === bound.navigation &&
      this.grantContext?.describe(page.port.id)?.url === '';
    if (owns && page.control.disarm(grant.requestId, bound.epoch)) {
      this.paint(page);
      if (close) this.grantContext?.close(page.port.id);
    }
  }
  private refreshGrant(grant: Grant) {
    if (grant.consumed || ['cancelled', 'expired'].includes(grant.state)) return;
    const selected = this.grantContext?.selectedScope();
    const selectionChanged =
      grant.selection &&
      (!selected ||
        Object.keys(grant.selection).some(
          (key) =>
            selected[key as keyof BrowserGrantScope] !==
            grant.selection![key as keyof BrowserGrantScope],
        ));
    const bound = grant.binding;
    const initializing = grant.initializing;
    const initializationChanged =
      initializing &&
      (this.pages.get(initializing.page.port.id) !== initializing.page ||
        initializing.page.control.grantEpoch !== initializing.epoch ||
        initializing.page.control.phase !== 'human' ||
        initializing.page.control.retained);
    const otherRetained = [...this.pages.values()].some(
      (page) =>
        page !== bound?.page &&
        page.control.retained &&
        page.port.scope.storeId === grant.storeId &&
        page.port.scope.sessionId === grant.sessionId,
    );
    if (
      this.grantNow() >= grant.expiresAt ||
      selectionChanged ||
      initializationChanged ||
      otherRetained ||
      (grant.requireExisting && this.existingGrantFailure(grant)) ||
      (bound &&
        (this.pages.get(bound.page.port.id) !== bound.page ||
          !bound.page.port.alive() ||
          bound.page.control.navigation !== bound.navigation ||
          bound.page.control.grantEpoch !== bound.epoch ||
          bound.page.control.phase !== (grant.state === 'question' ? 'human' : 'armed') ||
          bound.page.grantReservation !== grant.requestId))
    )
      this.endGrant(grant, 'expired');
  }
  private existingGrantFailure(grant: Grant) {
    const bound = grant.binding,
      pageId = grant.page.id,
      current = pageId ? this.pages.get(pageId) : undefined;
    if (!current?.port.alive()) return 'browser_page_existing_missing';
    if (
      !bound ||
      current !== bound.page ||
      current.port.id !== pageId ||
      current.control.binding.incarnation !== bound.incarnation ||
      current.control.binding.pageId !== pageId ||
      current.control.binding.storeId !== grant.storeId ||
      current.control.binding.sessionId !== grant.sessionId ||
      current.port.scope.storeId !== grant.storeId ||
      current.port.scope.sessionId !== grant.sessionId ||
      current.control.navigation !== bound.navigation ||
      !sameUrl(this.grantContext?.describe(current.port.id)?.url, grant.url)
    )
      return 'browser_page_existing_mismatch';
    return undefined;
  }
  private assertExistingGrant(grant: Grant) {
    if (!grant.requireExisting || grant.consumed || grant.state === 'cancelled') return;
    const failure = this.existingGrantFailure(grant);
    if (!failure) return;
    this.endGrant(grant, 'expired');
    throw hostError(failure);
  }
  private async grantRequest(input: Record<string, unknown>, boundary: DispatchBoundary) {
    if (!uuid(input.requestId)) throw hostError('page_request_invalid');
    for (const grant of this.grants.values()) this.refreshGrant(grant);
    let grant = this.grants.get(input.requestId);
    if (input.op === 'prepareGrant') {
      if (
        !['storeId', 'sessionId', 'executionId', 'browserId'].every((key) => id(input[key])) ||
        !http(input.url) ||
        (input.requireExisting !== undefined && input.requireExisting !== true) ||
        (input.existingPage !== undefined &&
          (input.requireExisting !== true ||
            !record(input.existingPage) ||
            Object.keys(input.existingPage as object)
              .sort()
              .join(',') !== 'incarnation,pageId' ||
            !id((input.existingPage as Record<string, unknown>).pageId) ||
            !uuid((input.existingPage as Record<string, unknown>).incarnation))) ||
        (input.requireExisting === true && input.existingPage === undefined)
      )
        throw hostError('page_request_invalid');
      if (grant) {
        if (
          ['storeId', 'sessionId', 'executionId', 'browserId', 'url'].some(
            (key) => grant![key as 'url'] !== input[key],
          ) ||
          grant.requireExisting !== input.requireExisting ||
          grant.existingPage?.pageId !==
            (input.existingPage as typeof grant.existingPage)?.pageId ||
          grant.existingPage?.incarnation !==
            (input.existingPage as typeof grant.existingPage)?.incarnation
        )
          throw hostError('browser_page_grant_intent_conflict');
        this.assertExistingGrant(grant);
        return this.grantResult(grant);
      }
      if (!this.grantContext) throw hostError('browser_page_grant_unavailable');
      const now = this.grantNow();
      const issuedAt = Number.parseInt(input.requestId.replaceAll('-', '').slice(0, 12), 16);
      if (input.requestId[14] !== '7' || issuedAt > now) throw hostError('page_request_invalid');
      const expiresAt = issuedAt + 10 * 60 * 1000;
      if (expiresAt <= now) throw hostError('browser_page_grant_expired');
      // Keep exact results and intent conflicts for the entire retry window. Never
      // evict an in-flight creator: its cleanup still owns the original page.
      for (const [requestId, prior] of this.grants) {
        if (
          prior.expiresAt <= now &&
          !prior.creating &&
          (prior.consumed || ['cancelled', 'expired'].includes(prior.state))
        )
          this.grants.delete(requestId);
      }
      if (this.grants.size >= 128) throw hostError('browser_page_grant_capacity');
      if (
        [...this.grants.values()].some(
          (prior) =>
            !prior.consumed &&
            !['cancelled', 'expired'].includes(prior.state) &&
            prior.storeId === input.storeId &&
            prior.sessionId === input.sessionId,
        )
      )
        throw hostError('browser_page_grant_pending');
      const owned = [...this.pages.values()].filter(
        (page) =>
          page.port.alive() &&
          page.port.scope.storeId === input.storeId &&
          page.port.scope.sessionId === input.sessionId,
      );
      const armed = owned.filter(
        (page) =>
          page.control.phase === 'armed' &&
          page.control.grantSource === 'manual' &&
          !page.grantReservation,
      );
      if (owned.some((page) => page.control.retained && !armed.includes(page)))
        throw hostError('browser_session_page_already_bound');
      const selected = this.grantContext.selectedScope();
      const existingPage = input.existingPage as Grant['existingPage'];
      if (
        !existingPage &&
        !armed.length &&
        (!selected || selected.storeId !== input.storeId || selected.sessionId !== input.sessionId)
      )
        throw hostError('browser_page_scope_denied');
      const matches = owned.filter((page) =>
        sameUrl(this.grantContext?.describe(page.port.id)?.url, String(input.url)),
      );
      if (!existingPage && matches.length > 1) throw hostError('browser_page_existing_ambiguous');
      const blank = owned.filter((page) => {
        const url = this.grantContext?.describe(page.port.id)?.url;
        return (
          !page.acquiredBefore &&
          page.lease === null &&
          page.control.navigation === 0 &&
          ['human', 'armed'].includes(page.control.phase) &&
          !page.grantReservation &&
          (url === '' || url === 'about:blank')
        );
      });
      const target = existingPage
        ? owned.find((page) => page.port.id === existingPage.pageId)
        : (matches[0] ?? (blank.length === 1 ? blank[0] : undefined));
      const detail = target && this.grantContext.describe(target.port.id);
      if (input.requireExisting) {
        if (!target) throw hostError('browser_page_existing_missing');
        if (
          target.control.binding.incarnation !== existingPage!.incarnation ||
          !sameUrl(detail?.url, String(input.url))
        )
          throw hostError('browser_page_existing_mismatch');
      } else if (!target) this.assertCanCreate();
      grant = {
        requestId: input.requestId,
        storeId: String(input.storeId),
        sessionId: String(input.sessionId),
        executionId: String(input.executionId),
        browserId: String(input.browserId),
        url: String(input.url),
        ...(input.requireExisting ? { requireExisting: true } : {}),
        ...(existingPage ? { existingPage: { ...existingPage } } : {}),
        state: target && armed.includes(target) ? 'ready' : 'question',
        consumed: false,
        page: target
          ? {
              kind: 'existing',
              id: target.port.id,
              title: detail?.title.slice(0, 512) ?? '网页',
              url: detail?.url.slice(0, 8192) ?? '',
            }
          : { kind: 'new', title: '新网页', url: '' },
        ...(!existingPage && selected ? { selection: { ...selected } } : {}),
        ...(target
          ? {
              binding: {
                page: target,
                incarnation: target.control.binding.incarnation,
                epoch: target.control.grantEpoch,
                navigation: target.control.navigation,
              },
            }
          : {}),
        expiresAt,
      };
      if (target) target.grantReservation = grant.requestId;
      this.grants.set(grant.requestId, grant);
      const pending = grant;
      grant.timer = setTimeout(() => this.endGrant(pending, 'expired'), expiresAt - now);
      grant.timer.unref();
      return this.grantResult(grant);
    }
    if (!grant) throw hostError('browser_page_grant_unavailable');
    if (input.op === 'inspectGrant') return this.grantResult(grant);
    if (input.op === 'cancelGrant') {
      this.endGrant(grant, 'cancelled');
      return this.grantResult(grant);
    }
    const legacy =
      id(input.interactionId) &&
      id(input.decisionRevision) &&
      input.executionId === undefined &&
      input.authorizationDigest === undefined;
    const dispatched =
      input.interactionId === undefined &&
      input.decisionRevision === undefined &&
      input.executionId === grant.executionId &&
      typeof input.authorizationDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(input.authorizationDigest);
    if (!legacy && !dispatched) throw hostError('page_request_invalid');
    const receipt = legacy
      ? {
          interactionId: input.interactionId as string,
          decisionRevision: input.decisionRevision as string,
        }
      : {
          executionId: input.executionId as string,
          authorizationDigest: input.authorizationDigest as string,
        };
    if (grant.receipt && JSON.stringify(grant.receipt) !== JSON.stringify(receipt))
      throw hostError('browser_page_grant_receipt_conflict');
    this.assertExistingGrant(grant);
    if (grant.state !== 'question') return this.grantResult(grant);
    if (grant.creation) {
      boundary.kind = 'effect_unknown';
      await grant.creation;
      return this.grantResult(grant);
    }
    grant.receipt = receipt;
    const pending = grant,
      context = this.grantContext;
    grant.creation = (async () => {
      let page = pending.binding?.page;
      if (!page) {
        const pageId = `browser-${randomUUID()}`;
        pending.creating = true;
        try {
          let ready: void | Promise<void>;
          try {
            boundary.kind = 'effect_unknown';
            ready = context!.create(pageId, {
              storeId: pending.storeId,
              sessionId: pending.sessionId,
            });
          } finally {
            const allocated = this.pages.get(pageId);
            if (allocated)
              pending.initializing = { page: allocated, epoch: allocated.control.grantEpoch };
          }
          await ready;
          page = this.pages.get(pageId);
          this.refreshGrant(pending);
          if (this.grantContext !== context || pending.state !== 'question')
            throw hostError('browser_page_grant_changed');
          if (
            !page?.port.alive() ||
            page !== pending.initializing?.page ||
            page.control.phase !== 'human' ||
            page.control.retained ||
            page.control.grantEpoch !== pending.initializing.epoch ||
            page.port.scope.storeId !== pending.storeId ||
            page.port.scope.sessionId !== pending.sessionId
          )
            throw hostError('browser_page_grant_create_failed');
          pending.page.id = pageId;
        } catch (error) {
          this.endGrant(pending, 'expired');
          throw error;
        } finally {
          pending.creating = false;
        }
      }
      this.assertExistingGrant(pending);
      boundary.kind = 'effect_unknown';
      page.control.arm(page.port.scope, pending.requestId);
      page.grantReservation = pending.requestId;
      pending.binding = {
        page,
        incarnation: page.control.binding.incarnation,
        epoch: page.control.grantEpoch,
        navigation: page.control.navigation,
      };
      pending.initializing = undefined;
      pending.state = 'committed';
      this.paint(page);
    })();
    await grant.creation;
    return this.grantResult(grant);
  }
  add(port: BrowserPagePort) {
    if (this.pages.has(port.id)) throw hostError('browser_page_capacity');
    this.assertCanCreate();
    const page: Page = {
      port,
      control: new BrowserPageLease({ ...port.scope, pageId: port.id, incarnation: randomUUID() }),
      lease: null,
      events: [],
      sequence: 0,
      visible: false,
    };
    this.pages.set(port.id, page);
    return () => {
      page.control.fail();
      page.unwatch?.();
      for (const [leaseId, owner] of this.leases)
        if (owner === page) {
          if (page.lease?.id === leaseId) {
            this.retiredLeases.set(leaseId, { page, lease: page.lease });
            if (this.retiredLeases.size > 128)
              this.retiredLeases.delete(this.retiredLeases.keys().next().value!);
          }
          this.leases.delete(leaseId);
        }
      page.events = [];
      page.dialog = undefined;
      page.pressed = undefined;
      page.consumedCapture = undefined;
      page.invalidCapture = undefined;
      this.paint(page);
      if (this.pages.get(port.id) === page) this.pages.delete(port.id);
    };
  }
  private paint(page: Page) {
    page.port.decorate({
      agent: page.control.phase === 'agent',
      visible: page.visible,
      navigation: page.control.navigation,
      cursor: page.control.cursor,
    });
    page.port.changed();
  }
  private watch(page: Page) {
    const lease = page.lease;
    page.unwatch?.();
    page.unwatch = page.port.onEvent((method, params, sessionId) => {
      if (
        page.lease !== lease ||
        sessionId ||
        (!method.startsWith('Page.') &&
          ![
            'DOM.documentUpdated',
            'Runtime.executionContextCreated',
            'Runtime.executionContextDestroyed',
            'Runtime.executionContextsCleared',
          ].includes(method))
      )
        return;
      if (method === 'Page.javascriptDialogOpening' && params && typeof params === 'object') {
        const type = (params as Record<string, unknown>).type;
        page.dialog =
          lease && ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(type))
            ? {
                dialogRef: randomUUID(),
                type: type as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
                lease,
                navigation: page.control.navigation,
              }
            : undefined;
      } else if (method === 'Page.javascriptDialogClosed') page.dialog = undefined;
      const event = { seq: ++page.sequence, method, params };
      if (
        page.events.length >= 128 ||
        Buffer.byteLength(JSON.stringify([...page.events, event])) > 512 * 1024
      ) {
        this.fail(page.port.id);
        return;
      }
      page.events.push(event);
    });
  }
  state(id: string) {
    const page = this.pages.get(id);
    return page
      ? {
          sessionId: page.port.scope.sessionId,
          phase: page.control.phase,
          incarnation: page.control.binding.incarnation,
          navigation: page.control.navigation,
          ...(page.lease ? { browserId: page.lease.browserId } : {}),
        }
      : undefined;
  }
  retained(id: string) {
    return this.pages.get(id)?.control.retained === true;
  }
  arm(id: string, scope: BrowserPageScope) {
    const page = this.pages.get(id);
    if (!page?.port.alive()) throw hostError('browser_page_unavailable');
    if (
      [...this.pages.values()].some(
        (other) =>
          other !== page &&
          other.control.retained &&
          other.port.scope.storeId === scope.storeId &&
          other.port.scope.sessionId === scope.sessionId,
      )
    )
      throw hostError('browser_session_page_already_bound');
    if (
      page.control.phase === 'armed' &&
      page.port.scope.storeId === scope.storeId &&
      page.port.scope.sessionId === scope.sessionId
    ) {
      if (!page.control.disarm()) page.control.fail();
    } else page.control.arm(scope);
    page.grantReservation = undefined;
    this.paint(page);
  }
  present(id: string, visible: boolean) {
    const page = this.pages.get(id);
    if (!page || page.visible === visible) return;
    page.visible = visible;
    this.paint(page);
  }
  navigate(id: string) {
    const page = this.pages.get(id);
    if (!page) return;
    page.control.navigate();
    page.consumedCapture = undefined;
    page.invalidCapture = undefined;
    page.dialog = undefined;
    page.pressed = undefined;
    this.paint(page);
  }
  fail(id: string) {
    const page = this.pages.get(id);
    if (!page) return;
    page.control.fail();
    page.dialog = undefined;
    page.unwatch?.();
    this.paint(page);
  }
  private destroyedLease(input: Record<string, unknown>) {
    const retired =
      typeof input.leaseId === 'string' ? this.retiredLeases.get(input.leaseId) : undefined;
    // Unregister alone is not destruction. Main's original port retains the exact
    // WebContents identity; replacement pages and merely detached views cannot qualify.
    if (!retired || retired.page.lease !== retired.lease) return;
    try {
      if (retired.page.port.alive() === false) return retired;
    } catch {}
    return;
  }
  private own(input: Record<string, unknown>) {
    const page = typeof input.leaseId === 'string' ? this.leases.get(input.leaseId) : undefined;
    if (!page || page.lease?.id !== input.leaseId || !page.port.alive())
      throw hostError(
        this.destroyedLease(input) ? 'browser_page_closed' : 'browser_page_lease_stale',
      );
    return page;
  }
  private result(page: Page) {
    return {
      leaseId: page.lease!.id,
      pageId: page.port.id,
      incarnation: page.control.binding.incarnation,
      navigation: page.control.navigation,
    };
  }
  private pageState(page: Page) {
    const detail = this.grantContext?.describe(page.port.id);
    if (
      !detail ||
      typeof detail.url !== 'string' ||
      typeof detail.title !== 'string' ||
      detail.title.length > 128
    )
      throw hostError('browser_page_state_invalid');
    const url = detail.url === '' ? 'about:blank' : detail.url;
    if (url !== 'about:blank' && !http(url)) throw hostError('browser_page_state_invalid');
    return { url, title: detail.title };
  }
  private async pointer(
    page: Page,
    lease: BrowserControlLease,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    boundary?: DispatchBoundary,
  ) {
    const invalid = () => {
      throw hostError('browser_page_pointer_invalid');
    };
    const point = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
      const entry = value as Record<string, unknown>;
      if (
        Object.keys(entry).length !== 2 ||
        !['x', 'y'].every(
          (key) =>
            typeof entry[key] === 'number' &&
            Number.isFinite(entry[key]) &&
            Number(entry[key]) >= 0,
        )
      )
        return invalid();
      return { x: Number(entry.x), y: Number(entry.y) };
    };
    if (
      !uuid(input.captureId) ||
      !['click', 'drag'].includes(String(input.kind)) ||
      (input.kind === 'click' && input.to !== undefined) ||
      (input.kind === 'drag' && input.to === undefined)
    )
      return invalid();
    const from = point(input.from),
      to = input.to === undefined ? from : point(input.to);
    const raw = page.port.captureMeta();
    const metadata =
      raw && typeof raw === 'object' ? (raw as { metadata?: unknown }).metadata : undefined;
    const proof =
      metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
    if (
      page.pointerBusy ||
      !page.port.validateCapture ||
      page.dialog ||
      page.control.phase !== 'agent' ||
      proof.captureId !== input.captureId ||
      page.consumedCapture === input.captureId ||
      page.invalidCapture === input.captureId ||
      proof.navigation !== page.control.navigation ||
      !['width', 'height', 'imageWidth', 'imageHeight'].every(
        (key) =>
          typeof proof[key] === 'number' && Number.isFinite(proof[key]) && Number(proof[key]) > 0,
      )
    )
      throw hostError('browser_page_pointer_stale');
    if (
      [from, to].some(
        (value) => value.x >= Number(proof.imageWidth) || value.y >= Number(proof.imageHeight),
      )
    )
      return invalid();
    const css = (value: { x: number; y: number }) => ({
      x: (value.x * Number(proof.width)) / Number(proof.imageWidth),
      y: (value.y * Number(proof.height)) / Number(proof.imageHeight),
    });
    const start = css(from),
      end = css(to),
      read = page.control.observe(lease);
    page.pointerBusy = true;
    let dispatched = false;
    const guard = async () => {
      if (
        signal?.aborted ||
        !read.current() ||
        page.control.phase !== 'agent' ||
        page.dialog ||
        page.invalidCapture === input.captureId ||
        !(await page.port.validateCapture!(String(input.captureId))) ||
        !read.current() ||
        signal?.aborted ||
        page.invalidCapture === input.captureId
      )
        throw hostError('browser_page_pointer_stale');
    };
    const send = async (
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
      position: { x: number; y: number },
      buttons: number,
    ) => {
      await guard();
      const done = page.control.dispatch(lease, {
        ...position,
        phase: type === 'mousePressed' ? 'press' : 'move',
      });
      try {
        dispatched = true;
        if (type === 'mousePressed')
          page.pressed = { ...position, lease, navigation: page.control.navigation };
        if (type === 'mouseReleased') page.pressed = undefined;
        if (boundary) boundary.kind = 'effect_unknown';
        const result = page.port.send('Input.dispatchMouseEvent', {
          type,
          ...position,
          button: 'left',
          buttons,
          clickCount: type === 'mouseMoved' ? 0 : 1,
        });
        this.paint(page);
        await result;
      } catch (error) {
        done(false);
        throw error;
      } finally {
        done();
        this.paint(page);
      }
    };
    try {
      await guard();
      if (page.consumedCapture === input.captureId) throw hostError('browser_page_pointer_stale');
      page.consumedCapture = String(input.captureId);
      await send('mouseMoved', start, 0);
      await send('mousePressed', start, 1);
      if (input.kind === 'drag')
        for (let step = 1; step <= 8; step++)
          await send(
            'mouseMoved',
            {
              x: start.x + ((end.x - start.x) * step) / 8,
              y: start.y + ((end.y - start.y) * step) / 8,
            },
            1,
          );
      await send('mouseReleased', end, 0);
      return { dispatched: true };
    } catch (error) {
      if (!dispatched) throw error;
      page.control.fail();
      this.paint(page);
      throw hostError('browser_page_pointer_outcome_unknown');
    } finally {
      page.pointerBusy = false;
      read.finish();
    }
  }
  private async dialog(
    page: Page,
    lease: BrowserControlLease,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    boundary?: DispatchBoundary,
  ) {
    if (!uuid(input.dialogRef) || !['accept', 'dismiss'].includes(String(input.response)))
      throw hostError('browser_page_dialog_invalid');
    const dialog = page.dialog;
    if (
      !dialog ||
      dialog.dialogRef !== input.dialogRef ||
      dialog.lease !== lease ||
      dialog.navigation !== page.control.navigation ||
      page.control.phase !== 'agent' ||
      signal?.aborted
    )
      throw hostError('browser_page_dialog_stale');
    const done = page.control.dispatch(lease);
    page.dialog = undefined;
    try {
      if (boundary) boundary.kind = 'effect_unknown';
      await page.port.send('Page.handleJavaScriptDialog', { accept: input.response === 'accept' });
      if (
        signal?.aborted ||
        this.pages.get(page.port.id) !== page ||
        page.lease !== lease ||
        !page.control.matches(lease) ||
        page.control.phase !== 'agent' ||
        page.control.navigation !== dialog.navigation ||
        page.dialog
      )
        throw hostError('browser_page_dialog_stale');
      // A semantic click can have opened its dialog on mousedown. Complete that
      // exact held button only while this lease/document still owns the page.
      const pressed = page.pressed;
      if (pressed && !page.dialog) {
        if (
          pressed.lease !== lease ||
          pressed.navigation !== page.control.navigation ||
          !page.control.matches(lease) ||
          page.control.phase !== 'agent'
        )
          throw hostError('browser_page_dialog_stale');
        page.pressed = undefined;
        await page.port.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: pressed.x,
          y: pressed.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
      }
      return { handled: true };
    } catch {
      done(false);
      page.control.fail();
      this.paint(page);
      throw hostError('browser_page_dialog_outcome_unknown');
    } finally {
      done();
    }
  }
  async request(value: unknown, signal?: AbortSignal): Promise<unknown> {
    return (await this.checkedResponse(value, signal)).value;
  }
  /** Trusted paired HTTP response; serialized and bounded by the same dispatch proof as request(). */
  async requestSerialized(value: unknown, signal?: AbortSignal): Promise<string> {
    return (await this.checkedResponse(value, signal)).body;
  }
  private async checkedResponse(value: unknown, signal?: AbortSignal) {
    const input = record(value);
    const boundary: DispatchBoundary = { kind: 'not_dispatched' };
    try {
      signal?.throwIfAborted();
      const result = await this.dispatchRequest(input, signal, boundary);
      const body = JSON.stringify({ ok: true, value: result });
      const maximum =
        input.op === 'cdp' && input.method === 'Page.captureScreenshot'
          ? 6 * 1024 * 1024
          : input.op === 'cdp' && input.method === 'Accessibility.getFullAXTree'
            ? 2 * 1024 * 1024
            : 512 * 1024;
      if (Buffer.byteLength(body) > maximum) throw hostError('browser_page_response_limit');
      return { value: result, body };
    } catch (cause) {
      // Foreign errors cannot mint Host codes or claim that dispatch never happened.
      const error = this.destroyedLease(input)
        ? hostError('browser_page_closed')
        : cause instanceof Error && localErrors.has(cause)
          ? cause
          : hostError('browser_page_request_failed');
      failures.set(error, { ...failureBinding(input), kind: boundary.kind });
      throw error;
    }
  }
  private async dispatchRequest(
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    boundary: DispatchBoundary,
  ): Promise<unknown> {
    const fields: Record<string, readonly string[]> = {
      prepareGrant: [
        'requestId',
        'storeId',
        'sessionId',
        'executionId',
        'browserId',
        'url',
        'requireExisting',
        'existingPage',
      ],
      inspectGrant: ['requestId'],
      commitGrant: [
        'requestId',
        'interactionId',
        'decisionRevision',
        'executionId',
        'authorizationDigest',
      ],
      cancelGrant: ['requestId'],
      acquire: ['storeId', 'sessionId', 'executionId', 'browserId', 'grantId', 'grantExecutionId'],
      cdp: ['leaseId', 'method', 'params', 'sessionId'],
      pageState: ['leaseId'],
      navigate: ['leaseId', 'url'],
      confirm: ['leaseId'],
      revoke: ['leaseId'],
      resume: ['leaseId'],
      release: ['leaseId', 'pause', 'channelRevoked'],
      events: ['leaseId', 'after'],
      capture: ['leaseId'],
      captureMeta: ['leaseId'],
      pointer: ['leaseId', 'captureId', 'kind', 'from', 'to'],
      dialogs: ['leaseId'],
      dialog: ['leaseId', 'dialogRef', 'response'],
    };
    if (
      typeof input.op !== 'string' ||
      !fields[input.op] ||
      Object.keys(input).some((key) => key !== 'op' && !fields[input.op as string]!.includes(key))
    )
      throw hostError('page_request_invalid');
    if (['prepareGrant', 'inspectGrant', 'commitGrant', 'cancelGrant'].includes(input.op)) {
      return this.grantRequest(input, boundary);
    }
    if (input.op === 'acquire') {
      if (
        Object.keys(input).some(
          (key) =>
            ![
              'op',
              'storeId',
              'sessionId',
              'executionId',
              'browserId',
              'grantId',
              'grantExecutionId',
            ].includes(key),
        ) ||
        !['storeId', 'sessionId', 'executionId', 'browserId'].every(
          (key) =>
            typeof input[key] === 'string' &&
            (input[key] as string).length > 0 &&
            (input[key] as string).length <= 128,
        )
      )
        throw hostError('page_request_invalid');
      let grant: Grant | undefined;
      if (input.grantId !== undefined) {
        if (!uuid(input.grantId) || !id(input.grantExecutionId))
          throw hostError('page_request_invalid');
        grant = this.grants.get(input.grantId);
        if (grant) this.refreshGrant(grant);
        if (grant?.consumed) throw hostError('browser_page_grant_consumed');
        if (grant) this.assertExistingGrant(grant);
        if (
          !grant ||
          !['ready', 'committed'].includes(grant.state) ||
          grant.storeId !== input.storeId ||
          grant.sessionId !== input.sessionId ||
          grant.browserId !== input.browserId ||
          grant.executionId !== input.grantExecutionId
        )
          throw hostError('browser_page_grant_changed');
      } else if (input.grantExecutionId !== undefined) throw hostError('page_request_invalid');
      const found = grant
        ? [grant.binding!.page]
        : [...this.pages.values()].filter(
            (page) =>
              page.port.scope.storeId === input.storeId &&
              page.port.scope.sessionId === input.sessionId &&
              page.control.phase === 'armed' &&
              page.control.grantSource === 'manual' &&
              !page.grantReservation,
          );
      if (found.length !== 1) throw hostError('browser_page_explicit_grant_required');
      const page = found[0]!;
      if (grant) {
        grant.consumed = true;
        grant.state = 'committed';
        clearTimeout(grant.timer);
        page.grantReservation = undefined;
      }
      boundary.kind = 'effect_unknown';
      page.lease = page.control.acquire(
        page.port.scope,
        input.browserId as string,
        input.executionId as string,
      );
      page.acquiredBefore = true;
      this.leases.set(page.lease.id, page);
      const acquired = page.lease;
      try {
        await page.port.attach();
        if (!page.control.matches(acquired) || page.control.phase !== 'acquiring')
          throw hostError('browser_page_lease_stale');
        const existingFailure = grant?.requireExisting
          ? this.existingGrantFailure(grant)
          : undefined;
        if (existingFailure) throw hostError(existingFailure);
        this.watch(page);
        this.paint(page);
        return this.result(page);
      } catch (error) {
        page.control.fail();
        this.paint(page);
        throw error;
      }
    }
    const destroyed = this.destroyedLease(input);
    if (destroyed && (input.op === 'revoke' || input.op === 'release')) {
      const closure = {
        kind: 'page_destroyed',
        leaseId: destroyed.lease.id,
        pageId: destroyed.lease.binding.pageId,
        incarnation: destroyed.lease.binding.incarnation,
      };
      if (input.op === 'revoke') return { revoked: true, closure };
      const idle = await destroyed.page.control.waitIdle();
      signal?.throwIfAborted();
      return {
        confirmed: idle && input.channelRevoked === true && input.pause !== true,
        detached: true,
        closure,
      };
    }
    const page = this.own(input),
      lease = page.lease!;
    if (input.op === 'pageState') {
      const read = page.control.observe(lease);
      try {
        boundary.kind = 'read_failed';
        const detail = this.pageState(page);
        signal?.throwIfAborted();
        if (this.pages.get(page.port.id) !== page || !read.current())
          throw hostError('browser_page_read_stale');
        return { ...this.result(page), ...detail };
      } finally {
        read.finish();
      }
    }
    if (input.op === 'navigate') {
      if (!http(input.url)) throw hostError('browser_page_navigation_denied');
      if (!page.port.navigate) throw hostError('browser_page_navigation_unavailable');
      const done = page.control.dispatch(lease);
      let dispatched = false;
      const current = () =>
        this.pages.get(page.port.id) === page &&
        page.port.alive() &&
        page.lease === lease &&
        page.control.matches(lease) &&
        page.control.phase === 'agent';
      try {
        const raw = page.port.captureMeta() as { metadata?: { captureId?: string } } | null;
        if (raw?.metadata?.captureId) page.invalidCapture = raw.metadata.captureId;
        const result = await page.port.navigate(String(input.url), signal, () => {
          signal?.throwIfAborted();
          if (dispatched || !current()) throw hostError('browser_page_lease_stale');
          // This callback and the one actual Page.navigate are in the same turn.
          dispatched = true;
          boundary.kind = 'effect_unknown';
        });
        signal?.throwIfAborted();
        if (
          !dispatched ||
          !current() ||
          !result.current() ||
          result.navigation !== page.control.navigation
        )
          throw hostError('browser_page_navigation_stale');
        const detail = this.pageState(page);
        if (!http(detail.url)) throw hostError('browser_page_navigation_stale');
        if (!current() || !result.current() || result.navigation !== page.control.navigation)
          throw hostError('browser_page_navigation_stale');
        return { ...this.result(page), ...detail };
      } catch (cause) {
        if (dispatched) {
          done(false);
          const error = hostError('browser_page_navigation_outcome_unknown');
          error.cause = cause;
          throw error;
        }
        throw cause;
      } finally {
        done();
        this.paint(page);
      }
    }
    if (input.op === 'pointer') return this.pointer(page, lease, input, signal, boundary);
    if (input.op === 'dialog') return this.dialog(page, lease, input, signal, boundary);
    if (input.op === 'dialogs') {
      if (page.control.phase !== 'agent' || !page.control.matches(lease))
        throw hostError('browser_page_dialog_stale');
      const dialog = page.dialog;
      return {
        dialogs:
          dialog && dialog.lease === lease && dialog.navigation === page.control.navigation
            ? [{ dialogRef: dialog.dialogRef, type: dialog.type }]
            : [],
      };
    }
    if (input.op === 'confirm') {
      boundary.kind = 'effect_unknown';
      page.control.confirm(lease);
      this.paint(page);
      return this.result(page);
    }
    if (input.op === 'revoke') {
      boundary.kind = 'effect_unknown';
      page.dialog = undefined;
      page.control.revoke(lease);
      this.paint(page);
      return { revoked: true };
    }
    if (input.op === 'resume') {
      boundary.kind = 'effect_unknown';
      const prior = lease.id;
      page.lease = page.control.reacquire(lease);
      this.leases.delete(prior);
      this.leases.set(page.lease.id, page);
      page.events = [];
      page.sequence = 0;
      const resumed = page.lease;
      try {
        await page.port.attach();
        if (!page.control.matches(resumed) || page.control.phase !== 'acquiring')
          throw hostError('browser_page_lease_stale');
        this.watch(page);
        this.paint(page);
        return this.result(page);
      } catch (error) {
        page.control.fail();
        this.paint(page);
        throw error;
      }
    }
    if (input.op === 'release') {
      boundary.kind = 'effect_unknown';
      page.unwatch?.();
      page.unwatch = undefined;
      await page.control.waitIdle();
      // A cancelled press is not a confirmed manual-input handoff. Never invent
      // a compensating click on behalf of the cancelled operation.
      if (page.pressed?.lease === lease) page.control.fail();
      let detached = false;
      try {
        detached = await page.port.detach();
      } catch {
        page.control.fail();
      }
      const evidence = { channelRevoked: input.channelRevoked === true, detached };
      const confirmed =
        input.pause === true
          ? page.control.pause(lease, evidence)
          : page.control.release(lease, evidence);
      if (confirmed && input.pause !== true) {
        this.leases.delete(lease.id);
        page.lease = null;
      }
      this.paint(page);
      let retainedPage:
        | { leaseId: string; pageId: string; incarnation: string; url: string; title: string }
        | undefined;
      if (confirmed && input.pause !== true) {
        try {
          const navigation = page.control.navigation;
          const detail = this.grantContext?.describe(page.port.id);
          if (
            detail &&
            http(detail.url) &&
            typeof detail.title === 'string' &&
            detail.title.length <= 128 &&
            this.pages.get(page.port.id) === page &&
            page.port.alive() &&
            page.control.binding === lease.binding &&
            page.control.navigation === navigation &&
            page.control.phase === 'human' &&
            page.lease === null
          )
            retainedPage = {
              leaseId: lease.id,
              pageId: page.port.id,
              incarnation: lease.binding.incarnation,
              url: detail.url,
              title: detail.title,
            };
        } catch {
          // A passive page description cannot prove an unobserved page. Keep
          // the release receipt, but offer no recovery candidate from this read.
        }
      }
      return { confirmed, detached, ...(retainedPage ? { retainedPage } : {}) };
    }
    if (input.op === 'capture' || input.op === 'captureMeta') {
      const read = page.control.observe(lease);
      try {
        boundary.kind = 'read_failed';
        const result = await (input.op === 'capture'
          ? page.port.capture()
          : page.port.captureMeta());
        if (!read.current()) throw hostError('browser_page_read_stale');
        return result;
      } finally {
        read.finish();
      }
    }
    if (input.op === 'events') {
      if (!Number.isSafeInteger(input.after) || Number(input.after) < 0)
        throw hostError('page_request_invalid');
      if (page.control.phase === 'unknown') throw hostError('browser_page_control_unknown');
      const events = page.events.filter((event) => event.seq > Number(input.after));
      page.events = page.events.filter((event) => event.seq > Number(input.after));
      return { events, cursor: page.sequence };
    }
    if (
      input.op !== 'cdp' ||
      typeof input.method !== 'string' ||
      !methods.has(input.method) ||
      input.sessionId
    )
      throw hostError('browser_page_method_denied');
    const params = input.params === undefined ? {} : record(input.params);
    if (input.method === 'Page.navigate' && !http(params.url))
      throw hostError('browser_page_navigation_denied');
    const setup = page.control.phase === 'acquiring';
    if (setup && (input.method.startsWith('Input.') || input.method === 'Page.navigate'))
      throw hostError('browser_page_not_ready');
    if (
      page.control.phase === 'agent' &&
      ['Page.getFrameTree', 'Accessibility.getFullAXTree'].includes(input.method) &&
      page.port.waitForDocument
    ) {
      const read = page.control.observe(lease);
      try {
        boundary.kind = 'read_failed';
        const ready = await page.port.waitForDocument(signal);
        signal?.throwIfAborted();
        if (!read.current()) throw hostError('browser_page_read_stale');
        if (!ready) throw hostError('browser_page_document_not_ready');
      } finally {
        read.finish();
      }
      // No await before dispatch below: recheck control in the same turn in which
      // the exact document/lease observation was validated and released.
    }
    let cursor: Omit<BrowserCursor, 'navigation'> | null | undefined =
      input.method === 'Input.dispatchMouseEvent' &&
      typeof params.x === 'number' &&
      typeof params.y === 'number'
        ? {
            x: params.x,
            y: params.y,
            phase: params.type === 'mousePressed' ? ('press' as const) : ('move' as const),
          }
        : undefined;
    if (
      input.method === 'Input.insertText' ||
      (input.method === 'Input.dispatchKeyEvent' &&
        ['char', 'keyDown', 'rawKeyDown'].includes(String(params.type)))
    ) {
      // Reserve the focus read too: handoff must drain it. Never send an input after a
      // navigation/revocation that happened while the asynchronous read was pending.
      const read = page.control.observe(lease);
      try {
        const point = await page.port.typingCursor();
        if (!read.current()) throw hostError('browser_page_read_stale');
        cursor =
          point &&
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          point.x >= 0 &&
          point.y >= 0
            ? { x: point.x, y: point.y, phase: 'type' }
            : null;
      } finally {
        read.finish();
      }
    }
    const done = page.control.dispatch(lease, cursor, setup);
    try {
      if (
        input.method.startsWith('Input.') ||
        input.method === 'Runtime.evaluate' ||
        input.method === 'Runtime.callFunctionOn' ||
        input.method === 'Page.navigate' ||
        input.method === 'Page.reload'
      ) {
        const raw = page.port.captureMeta() as { metadata?: { captureId?: string } } | null;
        if (raw?.metadata?.captureId) page.invalidCapture = raw.metadata.captureId;
      }
      if (
        input.method === 'Input.dispatchMouseEvent' &&
        params.type === 'mousePressed' &&
        typeof params.x === 'number' &&
        typeof params.y === 'number'
      )
        page.pressed = { x: params.x, y: params.y, lease, navigation: page.control.navigation };
      if (input.method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased')
        page.pressed = undefined;
      signal?.throwIfAborted();
      boundary.kind = readMethods.has(input.method) ? 'read_failed' : 'effect_unknown';
      const result = page.port.send(input.method, params);
      this.paint(page);
      return await result;
    } catch (error) {
      const preflight = error instanceof Error ? unsentPreflights.get(error) : undefined;
      if (error instanceof Error) unsentPreflights.delete(error);
      if (
        preflight?.pageId === page.port.id &&
        preflight.method === input.method &&
        ['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(String(input.method))
      )
        boundary.kind = 'not_dispatched';
      if (boundary.kind === 'effect_unknown') done(false);
      throw error;
    } finally {
      done();
      this.paint(page);
    }
  }
}
