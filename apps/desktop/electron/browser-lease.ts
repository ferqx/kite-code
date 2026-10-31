import { randomUUID } from 'node:crypto';

export type BrowserControlPhase =
  | 'human'
  | 'armed'
  | 'acquiring'
  | 'agent'
  | 'revoking'
  | 'unknown';
export interface BrowserPageScope {
  readonly storeId: string;
  readonly sessionId: string;
}
export interface BrowserPageBinding extends BrowserPageScope {
  readonly pageId: string;
  readonly incarnation: string;
}
export interface BrowserControlLease {
  readonly id: string;
  readonly binding: BrowserPageBinding;
  readonly browserId: string;
  readonly executionId: string;
}
export interface BrowserCursor {
  readonly x: number;
  readonly y: number;
  readonly phase: 'move' | 'press' | 'type';
  readonly navigation: number;
}

/** Main-only page control. A lease never owns or destroys the shared renderer process. */
export class BrowserPageLease {
  readonly binding: BrowserPageBinding;
  phase: BrowserControlPhase = 'human';
  navigation = 0;
  cursor: BrowserCursor | null = null;
  grantEpoch = 0;
  grantSource: string | null = null;
  private current: BrowserControlLease | null = null;
  private pending = 0;
  private idle = new Set<() => void>();
  private invalid = false;
  constructor(binding: BrowserPageBinding) {
    this.binding = Object.freeze({ ...binding });
  }
  get retained() {
    return this.phase !== 'human' || this.current !== null;
  }
  arm(scope: BrowserPageScope, source = 'manual') {
    if (
      this.phase !== 'human' ||
      this.current !== null ||
      scope.storeId !== this.binding.storeId ||
      scope.sessionId !== this.binding.sessionId
    )
      throw Error('browser_page_grant_denied');
    this.phase = 'armed';
    this.grantEpoch++;
    this.grantSource = source;
  }
  disarm(source?: string, epoch?: number) {
    if (
      this.phase !== 'armed' ||
      this.current !== null ||
      this.invalid ||
      (source !== undefined && this.grantSource !== source) ||
      (epoch !== undefined && this.grantEpoch !== epoch)
    )
      return false;
    this.phase = 'human';
    this.grantEpoch++;
    this.grantSource = null;
    this.cursor = null;
    return true;
  }
  acquire(scope: BrowserPageScope, browserId: string, executionId: string): BrowserControlLease {
    if (
      this.phase !== 'armed' ||
      scope.storeId !== this.binding.storeId ||
      scope.sessionId !== this.binding.sessionId
    )
      throw Error('browser_page_not_granted');
    this.phase = 'acquiring';
    this.current = Object.freeze({
      id: randomUUID(),
      binding: this.binding,
      browserId,
      executionId,
    });
    return this.current;
  }
  matches(lease: BrowserControlLease) {
    return this.current === lease && lease.binding === this.binding && !this.invalid;
  }
  confirm(lease: BrowserControlLease) {
    if (!this.matches(lease) || this.phase !== 'acquiring') throw Error('browser_page_lease_stale');
    this.phase = 'agent';
  }
  /** Invoke immediately before the real CDP call; acknowledgement is not webpage-effect proof. */
  dispatch(
    lease: BrowserControlLease,
    cursor?: Omit<BrowserCursor, 'navigation'> | null,
    setup = false,
  ) {
    if (
      !this.matches(lease) ||
      (this.phase !== 'agent' && !(setup && this.phase === 'acquiring' && !cursor))
    )
      throw Error('browser_page_control_denied');
    const navigation = this.navigation;
    this.pending++;
    if (cursor === null) this.cursor = null;
    if (cursor) {
      if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
        this.pending--;
        throw Error('browser_page_cursor_invalid');
      }
      this.cursor = { ...cursor, navigation };
    }
    const dispatchedCursor = this.cursor;
    let ended = false;
    return (succeeded = true) => {
      if (ended) return;
      ended = true;
      this.pending--;
      if (this.pending === 0) for (const ready of this.idle) ready();
      if (navigation !== this.navigation && this.cursor?.navigation === navigation)
        this.cursor = null;
      if (!succeeded && this.cursor === dispatchedCursor) this.cursor = null;
    };
  }
  /** Read pixels only while the exact retained human/Agent lease is valid. */
  observe(lease: BrowserControlLease) {
    const phase = this.phase,
      navigation = this.navigation;
    if (!this.matches(lease) || !['human', 'agent'].includes(phase))
      throw Error('browser_page_control_denied');
    this.pending++;
    let finished = false;
    return {
      current: () => this.matches(lease) && this.phase === phase && this.navigation === navigation,
      finish: () => {
        if (finished) return;
        finished = true;
        this.pending--;
        if (this.pending === 0) for (const ready of this.idle) ready();
      },
    };
  }
  waitIdle(milliseconds = 2000) {
    if (this.pending === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idle.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idle.delete(done);
        resolve(false);
      }, milliseconds);
      this.idle.add(done);
    });
  }
  navigate() {
    this.navigation++;
    this.cursor = null;
  }
  revoke(lease: BrowserControlLease) {
    if (this.current !== lease) throw Error('browser_page_lease_stale');
    this.phase = this.invalid ? 'unknown' : 'revoking';
    this.cursor = null;
  }
  pause(lease: BrowserControlLease, evidence: { channelRevoked: boolean; detached: boolean }) {
    if (this.current !== lease) throw Error('browser_page_lease_stale');
    if (!this.releaseReady(evidence)) return false;
    this.phase = 'human';
    return true;
  }
  reacquire(lease: BrowserControlLease) {
    if (!this.matches(lease) || this.phase !== 'human' || this.pending !== 0)
      throw Error('browser_page_resume_denied');
    this.phase = 'acquiring';
    this.current = Object.freeze({ ...lease, id: randomUUID() });
    return this.current;
  }
  private releaseReady(evidence: { channelRevoked: boolean; detached: boolean }) {
    if (
      this.invalid ||
      this.phase !== 'revoking' ||
      this.pending !== 0 ||
      !evidence.channelRevoked ||
      !evidence.detached
    ) {
      this.invalid = true;
      this.phase = 'unknown';
      this.cursor = null;
      return false;
    }
    return true;
  }
  release(lease: BrowserControlLease, evidence: { channelRevoked: boolean; detached: boolean }) {
    if (this.current !== lease) throw Error('browser_page_lease_stale');
    if (!this.releaseReady(evidence)) return false;
    this.phase = 'human';
    this.current = null;
    this.grantSource = null;
    return true;
  }
  fail() {
    if (this.phase === 'armed') {
      this.disarm();
    } else if (this.phase === 'human' && this.current === null) {
      this.phase = 'human';
      this.current = null;
    } else {
      this.invalid = true;
      this.phase = 'unknown';
    }
    this.cursor = null;
  }
}
