export interface SkillManifest {
  /** Presentation metadata projected from a compiled Workflow Contract. */
  name: string;
  description: string;
  source: 'project' | 'user';
  origin: '.kite-code' | '.agents';
}

export interface SkillScanOptions {
  userKiteCodeSkillsDir: string;
  userAgentsSkillsDir: string;
  projectKiteCodeSkillsDir: string;
  projectAgentsSkillsDir: string;
}
