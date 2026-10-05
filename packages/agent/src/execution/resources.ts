import type { ResourceRequest } from '../extensions';
import { AgentError } from '../storage/types';
import type { WorkspaceSerialLocks } from './resource-port';

class Semaphore {
  private used = 0;
  private readonly waiters: {
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.used < this.capacity) {
      this.used++;
      return this.releaseOnce();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.resolve(this.releaseOnce());
      } else this.used--;
    };
  }
}

/** The supported leaf set is one serial key, then one slot category. */
export class ExecutionResources {
  private readonly serial = new Map<string, Semaphore>();
  private readonly model: Semaphore;
  private readonly process: Semaphore;
  private readonly workspace?: WorkspaceSerialLocks;
  constructor(modelSlots = 4, processSlots = 4, workspace?: WorkspaceSerialLocks) {
    if (
      !Number.isInteger(modelSlots) ||
      modelSlots < 1 ||
      !Number.isInteger(processSlots) ||
      processSlots < 1
    )
      throw new AgentError('invalid_capacity');
    this.model = new Semaphore(modelSlots);
    this.process = new Semaphore(processSlots);
    this.workspace = workspace;
  }
  async acquire(
    request: ResourceRequest | undefined,
    scope: { sessionId: string; workspaceId: string },
    signal: AbortSignal,
  ): Promise<() => void> {
    const raw = request as Record<string, unknown> | undefined;
    if (
      raw &&
      (typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).some((key) => key !== 'serial' && key !== 'slot'))
    )
      throw new AgentError('unsupported_resource_combination');
    if (request?.slot !== undefined && request.slot !== 'model' && request.slot !== 'process')
      throw new AgentError('unsupported_resource_combination');
    if (request?.serial !== undefined) {
      if (
        !request.serial ||
        typeof request.serial !== 'object' ||
        Array.isArray(request.serial) ||
        Object.keys(request.serial).some((key) => key !== 'scope' && key !== 'key') ||
        !['runtime', 'workspace', 'session'].includes(request.serial.scope) ||
        typeof request.serial.key !== 'string' ||
        !request.serial.key ||
        request.serial.key.length > 256
      )
        throw new AgentError('unsupported_resource_combination');
      if (request.serial.scope === 'workspace' && !this.workspace)
        throw new AgentError('workspace_resource_lock_unavailable');
    }
    const releases: (() => void)[] = [];
    try {
      if (request?.serial) {
        if (request.serial.scope === 'workspace') {
          releases.push(
            await this.workspace!.acquire(
              { workspaceId: scope.workspaceId, key: request.serial.key },
              signal,
            ),
          );
        } else {
          const key = `${request.serial.scope}:${request.serial.scope === 'session' ? scope.sessionId : ''}:${request.serial.key}`;
          let semaphore = this.serial.get(key);
          if (!semaphore) {
            semaphore = new Semaphore(1);
            this.serial.set(key, semaphore);
          }
          releases.push(await semaphore.acquire(signal));
        }
      }
      if (request?.slot) releases.push(await this[request.slot].acquire(signal));
      return () => {
        for (const release of releases.reverse()) release();
      };
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
  }
}
