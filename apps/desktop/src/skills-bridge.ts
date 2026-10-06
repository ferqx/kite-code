import type { SkillCataloguePage } from '@kite-ai/client';

export type NativeSkillsScope = {
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
};

export type NativeSkillsRequest =
  | {
      method: 'settings.skills.open';
      generation: number;
      readId: string;
      viewSelection: number;
      historyEpoch: number;
    }
  | {
      method: 'settings.skills.next' | 'settings.skills.close';
      generation: number;
      readId: string;
    };

export type NativeSkillsPage = {
  kind: 'settings.skills.page';
  readId: string;
  scope: NativeSkillsScope;
  page: SkillCataloguePage;
};
