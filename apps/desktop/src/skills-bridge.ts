import type { UserSkillCataloguePage } from '@kite-ai/client';

export type NativeSkillsScope = {
  generation: number;
  storeId: string;
};

export type NativeSkillsRequest =
  | {
      method: 'settings.skills.open';
      generation: number;
      readId: string;
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
  page: UserSkillCataloguePage;
};
