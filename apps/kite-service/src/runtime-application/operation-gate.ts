export type RuntimeOperationGatePhase = 'open' | 'quiescing' | 'draining';

export class RuntimeOperationGateError extends Error {
  readonly code: 'operation_gate_quiescing' | 'operation_gate_draining';

  constructor(code: RuntimeOperationGateError['code'], message: string) {
    super(message);
    this.name = 'RuntimeOperationGateError';
    this.code = code;
  }
}

export interface RuntimeOperationQuiesceLease {
  readonly activeOperations: boolean;
  resume(): void;
  commitDrain(): Promise<void>;
}

interface IdleWaiter {
  readonly resolve: () => void;
}

/**
 * Admission gate for Service-side mutations. Quiescing flips admission synchronously before it
 * observes active work, so a stop caller cannot perform a check-then-mutate race.
 */
export class RuntimeOperationGate {
  #phase: RuntimeOperationGatePhase = 'open';
  #active = 0;
  #idleWaiters: IdleWaiter[] = [];
  #quiescePromise: Promise<RuntimeOperationQuiesceLease> | undefined;
  #lease: RuntimeOperationQuiesceLease | undefined;

  get phase(): RuntimeOperationGatePhase {
    return this.#phase;
  }

  get activeOperations(): boolean {
    return this.#active > 0;
  }

  async runMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#phase !== 'open') {
      throw new RuntimeOperationGateError(
        this.#phase === 'draining' ? 'operation_gate_draining' : 'operation_gate_quiescing',
        `Runtime mutation admission is ${this.#phase}.`,
      );
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#notifyIdle();
    }
  }

  quiesce(): Promise<RuntimeOperationQuiesceLease> {
    if (this.#phase === 'draining') {
      return Promise.reject(
        new RuntimeOperationGateError(
          'operation_gate_draining',
          'Runtime operation gate is already draining.',
        ),
      );
    }
    if (this.#quiescePromise) return this.#quiescePromise;

    // This assignment is the linearization point: no mutation can be admitted after it.
    this.#phase = 'quiescing';
    const observedActive = this.#active > 0;
    this.#quiescePromise = Promise.resolve().then(() => {
      const lease: RuntimeOperationQuiesceLease = {
        activeOperations: observedActive,
        resume: () => {
          if (this.#lease !== lease || this.#phase !== 'quiescing') return;
          this.#lease = undefined;
          this.#quiescePromise = undefined;
          this.#phase = 'open';
        },
        commitDrain: async () => {
          if (this.#lease !== lease) {
            if (this.#phase === 'draining') return;
            throw new RuntimeOperationGateError(
              'operation_gate_quiescing',
              'Runtime operation quiesce lease is no longer current.',
            );
          }
          if (this.#phase === 'draining') return;
          if (this.#phase !== 'quiescing') {
            throw new RuntimeOperationGateError(
              'operation_gate_quiescing',
              'Runtime operation gate was resumed before drain commit.',
            );
          }
          if (this.#active > 0) await this.#waitForIdle();
          this.#phase = 'draining';
          this.#lease = undefined;
          this.#quiescePromise = undefined;
        },
      };
      this.#lease = lease;
      return lease;
    });
    return this.#quiescePromise;
  }

  async waitForIdle(): Promise<void> {
    await this.#waitForIdle();
  }

  async #waitForIdle(): Promise<void> {
    if (this.#active === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push({ resolve }));
  }

  #notifyIdle(): void {
    if (this.#active !== 0) return;
    const waiters = this.#idleWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }
}

export function createRuntimeOperationGate(): RuntimeOperationGate {
  return new RuntimeOperationGate();
}
