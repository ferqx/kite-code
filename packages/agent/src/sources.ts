/** Explicit host-I/O entry point; importing the Agent root does not discover files. */

export type { ContextSource, ContextSources, SourceRequest } from './context';
export { agentContractSource } from './model-context';
export {
  createKnowledgeReadScope,
  type KnowledgeFileAccess,
  KnowledgeReadCleanupError,
  type KnowledgeReadScope,
} from './platform/knowledge-reads';
export { createProjectSources, type ProjectSourcesOptions } from './platform/project-sources';
