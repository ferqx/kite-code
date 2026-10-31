import type { JobDefinition, Json, ToolResult } from '../../extensions';

export interface BrowserAnnotation {
  ref: string;
  number: number;
  role: string;
  name?: string;
  box: { x: number; y: number; width: number; height: number };
}
/** Semantic references have no geometry until a separate visual observation. */
export interface BrowserElement {
  ref: string;
  role: string;
  name?: string;
}
export interface BrowserFrame {
  mimeType: 'image/jpeg';
  data: string;
  width: number;
  height: number;
  seq: string;
}
export type BrowserState =
  | 'starting'
  | 'agent'
  | 'pausing'
  | 'human'
  | 'closing'
  | 'closed'
  | 'outcome_unknown'
  | 'unavailable';
export interface BrowserView {
  browserId: string;
  generation: string;
  seq: string;
  state: BrowserState;
  url: string;
  title: string;
  frame: BrowserFrame | null;
  annotations: BrowserAnnotation[];
  selectedAnnotation: BrowserAnnotation | null;
  error?: string;
  /** Present only after a model-requested handoff is confirmed; plain explanatory text. */
  humanRequest?: string;
}
export type BrowserCommand =
  | { action: 'navigate'; url: string }
  | { action: 'snapshot' }
  | { action: 'click'; ref: string; seq: string }
  | { action: 'fill'; ref: string; seq: string; value: string }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount: number };
export interface BrowserTarget {
  browserId: string;
  generation: string;
}
/** Paired Main provenance only. Never a model page handle or renderer input. */
export interface BrowserSharedPageIdentity {
  readonly pageId: string;
  readonly incarnation: string;
}
export type BrowserControlOperation =
  | { action: 'snapshot' | 'capture' | 'back' | 'forward' | 'reload' | 'dialogs' }
  | { action: 'press'; key: string }
  | { action: 'hover'; ref: string; seq: string }
  | { action: 'select'; ref: string; seq: string; values: string[] }
  | { action: 'wait'; text: string; timeoutMs: number }
  | { action: 'dialog'; dialogRef: string; response: 'accept' | 'dismiss' }
  | {
      action: 'pointer';
      imageRef: string;
      kind: 'click' | 'drag';
      from: { x: number; y: number };
      to?: { x: number; y: number };
    };
export interface BrowserReleasedPage {
  readonly url: string;
  readonly title: string;
  readonly identity?: BrowserSharedPageIdentity;
  /** Initial navigation is still unknown; no new page or input before a fresh original-page snapshot. */
  readonly observationRequired?: true;
}
/** A trusted Service-scoped controller. It owns no resource before its ordinary Job starts. */
export interface BrowserController {
  readonly job: JobDefinition;
  /** Trusted host admission barrier. Never exposed as a model Tool or page operation. */
  prepareRun?(sessionId: string, runId: string): Promise<void>;
  /** Confirmed released shared-page metadata only; no current existence or control proof. */
  releasedPages?(sessionId: string): readonly BrowserReleasedPage[];
  /** Exact canonical URL, or the last closed page when omitted. Ambiguous identities are refused. */
  releasedPage?(sessionId: string, url?: string): BrowserReleasedPage | null;
  /** Trusted Main-confirmed missing original only. Removes metadata, never retries or grants control. */
  invalidateMissingReleasedPage?(sessionId: string, identity: BrowserSharedPageIdentity): boolean;
  /** Internal semantic API. Public v1 Tool inputs and compatibility behavior are unchanged. */
  control?(
    sessionId: string,
    target: BrowserTarget,
    operation: BrowserControlOperation,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  observe?(sessionId: string, target: BrowserTarget, signal: AbortSignal): Promise<ToolResult>;
  /** Host-only note capture; human mode remains unavailable to model DOM reads. */
  captureNote?(sessionId: string, target: BrowserTarget, signal: AbortSignal): Promise<ToolResult>;
  image?(
    sessionId: string,
    target: BrowserTarget,
    signal: AbortSignal,
  ): Promise<{
    data: string;
    width: number;
    height: number;
    seq: string;
    imageRef?: string;
    viewport?: { width: number; height: number };
    navigation?: number;
  }>;
  view(sessionId: string): BrowserView | null;
  command(
    sessionId: string,
    target: BrowserTarget,
    command: BrowserCommand,
    signal: AbortSignal,
    human?: boolean,
  ): Promise<ToolResult>;
  handoff(
    sessionId: string,
    target: BrowserTarget,
    signal: AbortSignal,
    reason?: string,
  ): Promise<ToolResult>;
  /** In-memory lifecycle observation only; grants no control or Runtime authority. */
  watchControl(
    sessionId: string,
    target: BrowserTarget,
    listener: (state: BrowserState) => void,
  ): () => void;
  resume(sessionId: string, target: BrowserTarget, signal: AbortSignal): Promise<ToolResult>;
  select(
    sessionId: string,
    target: BrowserTarget,
    seq: string,
    ref: string | null,
  ): Promise<ToolResult>;
  close(sessionId: string, target: BrowserTarget): Promise<ToolResult>;
}
export const browserExtensionId = 'builtin.browser';
export const browserViewContentType = 'application/vnd.kite.browser-view+json';
export const browserJobId = 'browser.session';
export const asJson = (value: unknown): Json => value as Json;
