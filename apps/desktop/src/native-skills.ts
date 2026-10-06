import { ClientError, type SkillCataloguePage, verifySkillCataloguePage } from '@kite-ai/client';
import type { NativeBridge } from './native-bridge';
import type { NativeSkillsPage, NativeSkillsScope } from './skills-bridge';

export async function readNativeSkillCatalogue(input: {
  bridge: NativeBridge;
  scope: NativeSkillsScope;
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<SkillCataloguePage> {
  const scope = { ...input.scope },
    readId = crypto.randomUUID();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void input.bridge
      .request({ method: 'settings.skills.close', generation: scope.generation, readId })
      .catch(() => undefined);
  };
  const check = () => {
    if (input.signal.aborted || !input.isCurrent())
      throw new ClientError('skill_catalogue_view_changed');
  };
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      close();
      reject(new ClientError('skill_catalogue_view_changed'));
    };
  });
  input.signal.addEventListener('abort', abort, { once: true });
  const read = async (
    method: 'settings.skills.open' | 'settings.skills.next',
    afterId?: string,
    revision?: string,
  ) => {
    check();
    const result = await Promise.race([
      input.bridge.request(
        method === 'settings.skills.open'
          ? {
              method,
              generation: scope.generation,
              readId,
              viewSelection: scope.viewSelection,
              historyEpoch: scope.historyEpoch,
            }
          : { method, generation: scope.generation, readId },
      ),
      cancelled,
    ]);
    check();
    if (!result || !('kind' in result) || result.kind !== 'settings.skills.page')
      throw new ClientError('skill_catalogue_page_invalid');
    const value = result as NativeSkillsPage;
    if (
      value.readId !== readId ||
      !value.scope ||
      Object.keys(scope).some(
        (key) =>
          value.scope[key as keyof NativeSkillsScope] !== scope[key as keyof NativeSkillsScope],
      )
    )
      throw new ClientError('skill_catalogue_identity_mismatch');
    return verifySkillCataloguePage(value.page, {
      storeId: scope.storeId,
      workspaceId: scope.workspaceId,
      ...(revision ? { revision, afterId } : {}),
    });
  };
  try {
    check();
    const first = await read('settings.skills.open'),
      entries = [...first.entries];
    let page = first;
    while (!page.complete) {
      page = await read('settings.skills.next', page.nextAfterId!, first.revision);
      if (page.availability !== first.availability || page.reason !== first.reason)
        throw new ClientError('skill_catalogue_changed');
      entries.push(...page.entries);
    }
    check();
    return { ...first, entries, nextAfterId: null, complete: true };
  } finally {
    input.signal.removeEventListener('abort', abort);
    close();
  }
}
