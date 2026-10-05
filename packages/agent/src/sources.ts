/** Explicit host-I/O entry point; importing the Agent root does not discover files. */

export type { ContextSource, ContextSources, SourceRequest } from './context';
export { createProjectSources, type ProjectSourcesOptions } from './platform/project-sources';
