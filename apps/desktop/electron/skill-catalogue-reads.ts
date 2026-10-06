import { type AgentClient, ClientError, verifySkillCataloguePage } from '@kite-ai/client';
import type { NativeSkillsPage, NativeSkillsScope } from '../src/skills-bridge';

type Lease = {
  readId: string;
  scope: NativeSkillsScope;
  abort: AbortController;
  revision?: string;
  afterId?: string;
  complete: boolean;
  reading: boolean;
};

/** Read-only view lease. Public pages stay bounded; the whole directory has no item quota. */
export class NativeSkillCatalogueReads {
  private lease: Lease | undefined;
  private readonly client: AgentClient;
  private readonly current: () => NativeSkillsScope | undefined;
  constructor(client: AgentClient, current: () => NativeSkillsScope | undefined) {
    this.client = client;
    this.current = current;
  }

  private check(lease: Lease) {
    const scope = this.current();
    if (
      this.lease !== lease ||
      lease.abort.signal.aborted ||
      !scope ||
      Object.keys(lease.scope).some(
        (key) =>
          scope[key as keyof NativeSkillsScope] !== lease.scope[key as keyof NativeSkillsScope],
      )
    )
      throw new ClientError('skill_catalogue_view_changed');
  }

  async open(input: {
    readId: string;
    viewSelection: number;
    historyEpoch: number;
  }): Promise<NativeSkillsPage> {
    const scope = this.current();
    if (
      !scope ||
      scope.viewSelection !== input.viewSelection ||
      scope.historyEpoch !== input.historyEpoch
    )
      throw new ClientError('native_selection_changed');
    if (!this.client.serverInfo?.capabilities.includes('skill_catalogue'))
      throw new ClientError('capability_unavailable');
    this.release();
    const lease: Lease = {
      readId: input.readId,
      scope: { ...scope },
      abort: new AbortController(),
      complete: false,
      reading: false,
    };
    this.lease = lease;
    return this.readPage(lease);
  }

  async next(readId: string): Promise<NativeSkillsPage> {
    const lease = this.lease;
    if (!lease || lease.readId !== readId) throw new ClientError('skill_catalogue_read_missing');
    this.check(lease);
    if (lease.reading) throw new ClientError('skill_catalogue_read_busy');
    if (lease.complete || !lease.revision || !lease.afterId)
      throw new ClientError('skill_catalogue_read_complete');
    return this.readPage(lease);
  }

  private async readPage(lease: Lease): Promise<NativeSkillsPage> {
    this.check(lease);
    lease.reading = true;
    try {
      const options = {
        storeId: lease.scope.storeId,
        ...(lease.revision ? { revision: lease.revision, afterId: lease.afterId } : {}),
        byteLimit: 131072,
        signal: lease.abort.signal,
      };
      const value = await this.client.listSkills(lease.scope.workspaceId, options);
      this.check(lease);
      const page = verifySkillCataloguePage(value, {
        storeId: lease.scope.storeId,
        workspaceId: lease.scope.workspaceId,
        ...(lease.revision ? { revision: lease.revision, afterId: lease.afterId } : {}),
      });
      this.check(lease);
      lease.revision = page.revision;
      if (Buffer.byteLength(JSON.stringify(page)) > 131072)
        throw new ClientError('skill_catalogue_page_too_large');
      lease.afterId = page.nextAfterId ?? undefined;
      lease.complete = page.complete;
      return {
        kind: 'settings.skills.page',
        readId: lease.readId,
        scope: { ...lease.scope },
        page,
      };
    } catch (error) {
      if (this.lease === lease) this.release();
      throw error;
    } finally {
      lease.reading = false;
    }
  }

  close(readId: string) {
    if (this.lease?.readId === readId) this.release();
  }

  release() {
    const lease = this.lease;
    this.lease = undefined;
    lease?.abort.abort();
  }
}
