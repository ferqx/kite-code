import {
  type AgentClient,
  ClientError,
  verifyUserSkillCataloguePage,
  verifyUserSkillDocument,
} from '@kite-ai/client';
import type {
  NativeSkillDocument,
  NativeSkillsPage,
  NativeSkillsScope,
} from '../src/skills-bridge';

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
  private documentLease: Pick<Lease, 'readId' | 'scope' | 'abort'> | undefined;
  private readonly client: AgentClient;
  private readonly current: () => NativeSkillsScope | undefined;
  constructor(client: AgentClient, current: () => NativeSkillsScope | undefined) {
    this.client = client;
    this.current = current;
  }

  private check(
    lease: Pick<Lease, 'readId' | 'scope' | 'abort'>,
    current = this.lease as Pick<Lease, 'readId' | 'scope' | 'abort'> | undefined,
  ) {
    const scope = this.current();
    if (
      current !== lease ||
      lease.abort.signal.aborted ||
      !scope ||
      Object.keys(lease.scope).some(
        (key) =>
          scope[key as keyof NativeSkillsScope] !== lease.scope[key as keyof NativeSkillsScope],
      )
    )
      throw new ClientError('skill_catalogue_view_changed');
  }

  async open(input: { readId: string }): Promise<NativeSkillsPage> {
    const scope = this.current();
    if (!scope) throw new ClientError('native_generation_changed');
    if (!this.client.serverInfo?.capabilities.includes('user_skill_catalogue'))
      throw new ClientError('capability_unavailable');
    this.releaseCatalogue();
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
      const value = await this.client.listUserSkills(options);
      this.check(lease);
      const page = verifyUserSkillCataloguePage(value, {
        storeId: lease.scope.storeId,
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
    if (this.lease?.readId === readId) this.releaseCatalogue();
  }

  async document(input: {
    readId: string;
    skillId: string;
    skillVersion: string;
    revision: string;
  }): Promise<NativeSkillDocument> {
    const scope = this.current();
    if (!scope) throw new ClientError('native_generation_changed');
    if (!this.client.serverInfo?.capabilities.includes('user_skill_document'))
      throw new ClientError('capability_unavailable');
    this.releaseDocument();
    const lease = { readId: input.readId, scope: { ...scope }, abort: new AbortController() };
    this.documentLease = lease;
    try {
      const value = await this.client.readUserSkillDocument({
        storeId: scope.storeId,
        skillId: input.skillId,
        skillVersion: input.skillVersion,
        revision: input.revision,
        signal: lease.abort.signal,
      });
      this.check(lease, this.documentLease);
      const document = verifyUserSkillDocument(value, {
        storeId: scope.storeId,
        skillId: input.skillId,
        skillVersion: input.skillVersion,
        revision: input.revision,
      });
      return {
        kind: 'settings.skills.document',
        readId: lease.readId,
        scope: { ...lease.scope },
        document,
      };
    } catch (error) {
      if (this.documentLease === lease) this.releaseDocument();
      throw error;
    }
  }
  closeDocument(readId: string) {
    if (this.documentLease?.readId === readId) this.releaseDocument();
  }
  private releaseDocument() {
    const lease = this.documentLease;
    this.documentLease = undefined;
    lease?.abort.abort();
  }
  private releaseCatalogue() {
    const lease = this.lease;
    this.lease = undefined;
    lease?.abort.abort();
  }
  release() {
    this.releaseCatalogue();
    this.releaseDocument();
  }
}
