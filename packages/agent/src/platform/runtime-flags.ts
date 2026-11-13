/** Keep standalone Node processes from resolving packages from ambient global locations. */
export const nodeRuntimeFlags = Object.freeze(['--no-global-search-paths']);
