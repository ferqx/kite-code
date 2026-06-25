export interface SkillManifest {
  name: string; // frontmatter name, unique identifier
  description: string; // frontmatter description
  source: 'project' | 'user';
  origin: '.kite-code' | '.agents';
}

export interface ValidatedSkill {
  name: string;
  description: string;
  content: string; // SKILL.md body without frontmatter
}

export interface SkillScanOptions {
  userKiteCodeSkillsDir: string;
  userAgentsSkillsDir: string;
  projectKiteCodeSkillsDir: string;
  projectAgentsSkillsDir: string;
}
