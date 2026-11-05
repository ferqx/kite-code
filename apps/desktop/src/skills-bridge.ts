import type { UserSkillCataloguePage, UserSkillDocument } from '@kite-ai/client';

export type NativeSkillsScope = {
  generation: number;
  storeId: string;
};

export type NativeSkillsRequest =
  | {
      method: 'settings.skills.document';
      generation: number;
      readId: string;
      skillId: string;
      skillVersion: string;
      revision: string;
    }
  | { method: 'settings.skills.document.close'; generation: number; readId: string }
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
export type NativeSkillDocument = {
  kind: 'settings.skills.document';
  readId: string;
  scope: NativeSkillsScope;
  document: UserSkillDocument;
};
