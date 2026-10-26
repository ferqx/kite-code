import type { JobDefinition, Json, ToolResult } from '../../extensions';

export interface BrowserAnnotation {
  ref: string;
  number: number;
  role: string;
  name?: string;
  box: { x: number; y: number; width: number; height: number };
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
/** A trusted Service-scoped controller. It owns no resource before its ordinary Job starts. */
export interface BrowserController {
  readonly job: JobDefinition;
  view(sessionId: string): BrowserView | null;
  command(
    sessionId: string,
    target: BrowserTarget,
    command: BrowserCommand,
    signal: AbortSignal,
    human?: boolean,
  ): Promise<ToolResult>;
  handoff(sessionId: string, target: BrowserTarget, signal: AbortSignal): Promise<ToolResult>;
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
