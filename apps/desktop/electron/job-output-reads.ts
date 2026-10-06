import { type AgentClient, ClientError, ExecutionOutputPages } from '@kite-ai/client';
import {
  type NativeJobOutputPage,
  type NativeJobOutputScope,
  nativeJobOutputPageBytes,
} from '../src/job-output-bridge';

type Lease = {
  readId: string;
  scope: NativeJobOutputScope;
  abort: AbortController;
  pages?: ExecutionOutputPages;
  limit: number;
  reading: boolean;
};

/** Each exact Job owns a read lease. Releasing it only aborts public GETs. */
export class NativeJobOutputReads {
  private readonly leases = new Map<string, Lease>();
  private readonly client: AgentClient;
  private readonly current: (
    executionId: string,
    readId: string,
  ) => NativeJobOutputScope | undefined;
  constructor(
    client: AgentClient,
    current: (executionId: string, readId: string) => NativeJobOutputScope | undefined,
  ) {
    this.client = client;
    this.current = current;
  }
  private check(lease: Lease) {
    const now = this.current(lease.scope.executionId, lease.readId);
    if (
      this.leases.get(lease.readId) !== lease ||
      lease.abort.signal.aborted ||
      !now ||
      Object.keys(lease.scope).some(
        (key) =>
          now[key as keyof NativeJobOutputScope] !== lease.scope[key as keyof NativeJobOutputScope],
      )
    )
      throw new ClientError('job_output_view_changed');
  }
  async open(input: {
    readId: string;
    executionId: string;
    viewSelection: number;
    historyEpoch: number;
  }): Promise<NativeJobOutputPage> {
    const scope = this.current(input.executionId, input.readId);
    if (
      !scope ||
      scope.viewSelection !== input.viewSelection ||
      scope.historyEpoch !== input.historyEpoch
    )
      throw new ClientError('native_selection_changed');
    if (this.leases.has(input.readId)) throw new ClientError('job_output_read_busy');
    // Register before the first await so a concurrent close cannot miss the lease.
    const lease: Lease = {
      readId: input.readId,
      scope: { ...scope },
      abort: new AbortController(),
      limit: 200,
      reading: true,
    };
    this.leases.set(lease.readId, lease);
    try {
      const signal = lease.abort.signal;
      await this.client.verifyConnection({ signal });
      this.check(lease);
      const execution = await this.client.getExecution(scope.executionId, { signal });
      this.check(lease);
      if (
        execution.id !== scope.executionId ||
        execution.sessionId !== scope.sessionId ||
        execution.originStoreId !== scope.storeId ||
        execution.kind !== 'job'
      )
        throw new ClientError('job_output_identity_mismatch');
      return await this.readPage(lease);
    } catch (error) {
      this.closeLease(lease);
      throw error;
    } finally {
      lease.reading = false;
    }
  }
  async next(readId: string): Promise<NativeJobOutputPage> {
    const lease = this.leases.get(readId);
    if (!lease) throw new ClientError('job_output_read_missing');
    this.check(lease);
    if (lease.reading) throw new ClientError('job_output_read_busy');
    if (!lease.pages || lease.pages.complete) throw new ClientError('job_output_read_complete');
    lease.reading = true;
    try {
      return await this.readPage(lease);
    } catch (error) {
      this.closeLease(lease);
      throw error;
    } finally {
      lease.reading = false;
    }
  }
  private async readPage(lease: Lease): Promise<NativeJobOutputPage> {
    const signal = lease.abort.signal;
    while (true) {
      this.check(lease);
      await this.client.verifyConnection({ signal });
      this.check(lease);
      const afterSeq = lease.pages?.afterSeq ?? '0';
      const page = await this.client.listExecutionOutput(lease.scope.executionId, {
        afterSeq,
        ...(lease.pages ? { upperSeq: lease.pages.upperSeq! } : {}),
        limit: lease.limit,
        signal,
      });
      this.check(lease);
      await this.client.verifyConnection({ signal });
      this.check(lease);
      lease.pages ??= new ExecutionOutputPages(lease.scope.executionId, page.highWaterSeq);
      // The public API bounds normal-row count, not encoded bytes. Retry a smaller
      // page at the same after/H, including when the first page was too large.
      if (Buffer.byteLength(JSON.stringify(page)) > nativeJobOutputPageBytes - 4096) {
        lease.pages.preview(page);
        if (lease.limit === 1) throw new ClientError('job_output_page_too_large');
        lease.limit = Math.max(1, Math.floor(lease.limit / 2));
        continue;
      }
      const verified = lease.pages.accept(page);
      return {
        kind: 'jobOutput.page',
        readId: lease.readId,
        scope: { ...lease.scope },
        afterSeq,
        upperSeq: lease.pages.upperSeq!,
        nextAfterSeq: lease.pages.afterSeq,
        complete: lease.pages.complete,
        page: verified,
      };
    }
  }
  private closeLease(lease: Lease) {
    if (this.leases.get(lease.readId) === lease) this.leases.delete(lease.readId);
    lease.abort.abort();
  }
  close(readId: string) {
    const lease = this.leases.get(readId);
    if (lease) this.closeLease(lease);
  }
  release() {
    for (const lease of this.leases.values()) this.closeLease(lease);
  }
}
