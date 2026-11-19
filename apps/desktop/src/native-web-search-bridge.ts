import type { WebSearchDisplay } from '@kite-ai/ui/desktop';
import type { NativeBridge } from './native-bridge';
import type {
  SearchDraft,
  SearchProbe,
  SearchView,
  WebSearchSettingsPort,
} from './web-search-settings-model';

type Scope = { generation: number; expectedStoreId: string };
export type NativeSearchRequest = Scope &
  (
    | { method: 'webSearch.settings.read' }
    | {
        method: 'webSearch.settings.save';
        revision: string;
        draft: SearchDraft;
        credential?: { providerId: string; secret: string };
      }
    | { method: 'webSearch.settings.test'; revision: string; sessionId: string }
    | {
        method: 'webSearch.evidence';
        sessionId: string;
        executionId: string;
        viewSelection: number;
      }
  );
export type NativeSearchResult =
  | { kind: 'webSearch.settings'; view: SearchView }
  | { kind: 'webSearch.test'; probe: SearchProbe }
  | { kind: 'webSearch.evidence'; evidence: WebSearchDisplay | null };
export function nativeSearchSettingsPort(
  bridge: NativeBridge,
  scope: Scope,
  sessionId?: string,
): WebSearchSettingsPort {
  async function request(input: NativeSearchRequest) {
    const value = await bridge.request(input);
    if (!value || !('kind' in value)) throw Error('web_search_unavailable');
    return value;
  }
  return {
    read: async () => {
      const r = await request({ method: 'webSearch.settings.read', ...scope });
      if (r.kind === 'webSearch.settings' && 'view' in r) return r.view;
      throw Error('web_search_unavailable');
    },
    save: async (revision, draft, credentials) => {
      if (credentials.length > 1) throw Error('invalid_request');
      const r = await request({
        method: 'webSearch.settings.save',
        ...scope,
        revision,
        draft,
        ...(credentials[0] ? { credential: credentials[0] } : {}),
      });
      if (r.kind === 'webSearch.settings' && 'view' in r) return r.view;
      throw Error('web_search_unavailable');
    },
    test: async (revision) => {
      if (!sessionId) throw Error('web_search_unavailable');
      const r = await request({ method: 'webSearch.settings.test', ...scope, sessionId, revision });
      if (r.kind === 'webSearch.test' && 'probe' in r) return r.probe;
      throw Error('web_search_unavailable');
    },
  };
}
