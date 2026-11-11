export type SkillMarketplaceSelection = {
  source: string;
  skillId: string;
};

export type SkillMarketplaceResult = SkillMarketplaceSelection & {
  name: string;
  installs: number;
};

export type SkillMarketplaceInstallResult = {
  status: 'installed' | 'already-installed';
  name: string;
};

export const installedSkillIdPrefix = 'user-skill.';

export type SkillMarketplaceUninstallSelection = {
  skillId: string;
  skillVersion: string;
};

export type SkillMarketplaceUninstallResult = {
  status: 'uninstalled' | 'already-uninstalled';
  skillId: string;
};

export type NativeSkillMarketplaceRequest =
  | { method: 'settings.skills.search'; generation: number; query: string }
  | {
      method: 'settings.skills.install';
      generation: number;
      selection: SkillMarketplaceSelection;
    }
  | {
      method: 'settings.skills.uninstall';
      generation: number;
      selection: SkillMarketplaceUninstallSelection;
    };

export type NativeSkillMarketplaceResult =
  | { kind: 'settings.skills.search'; results: readonly SkillMarketplaceResult[] }
  | { kind: 'settings.skills.install'; result: SkillMarketplaceInstallResult }
  | { kind: 'settings.skills.uninstall'; result: SkillMarketplaceUninstallResult };

export function isSkillMarketplaceQuery(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 2 &&
    value.length <= 100 &&
    value === value.trim() &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function validSkillSlug(value: string) {
  return (
    /^[a-z\d](?:[a-z\d-]{0,62}[a-z\d])?$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|computer-use)$/.test(value)
  );
}

export function isSkillMarketplaceSelection(value: unknown): value is SkillMarketplaceSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { source, skillId } = value as Partial<SkillMarketplaceSelection>;
  if (Object.keys(value).length !== 2 || typeof source !== 'string' || typeof skillId !== 'string')
    return false;
  const [owner, repo, ...extra] = source.split('/');
  return (
    extra.length === 0 &&
    !!owner &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) &&
    !!repo &&
    /^[a-z\d_.-]{1,100}$/i.test(repo) &&
    repo !== '.' &&
    repo !== '..' &&
    validSkillSlug(skillId)
  );
}

export function isSkillMarketplaceUninstallSelection(
  value: unknown,
): value is SkillMarketplaceUninstallSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { skillId, skillVersion } = value as Partial<SkillMarketplaceUninstallSelection>;
  return (
    Object.keys(value).length === 2 &&
    typeof skillId === 'string' &&
    skillId.startsWith(installedSkillIdPrefix) &&
    validSkillSlug(skillId.slice(installedSkillIdPrefix.length)) &&
    typeof skillVersion === 'string' &&
    /^[0-9a-f]{64}$/.test(skillVersion)
  );
}
