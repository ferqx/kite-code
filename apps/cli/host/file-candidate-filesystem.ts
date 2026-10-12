/** Private host I/O boundary. It grants no execution or configurable filesystem authority. */
export interface CandidateDirectory {
  verifyCanonicalPath(path: string): void;
  stamp(): string;
  entries(): readonly { name: string; type: number }[];
  openDirectory(name: string): CandidateDirectory;
  openIgnoreFile(): CandidateIgnoreFile;
  close(): void;
}

export interface CandidateIgnoreFile {
  facts(): { regular: boolean; links: number; stamp: string };
  read(buffer: Uint8Array): number;
  close(): void;
}

/** Loading the host does not initialize a platform backend or touch a Workspace. */
export function openCandidateDirectory(canonicalPath: string): CandidateDirectory {
  if (process.platform === 'win32') {
    const { openWindowsCandidateDirectory } =
      require('./file-candidate-windows') as typeof import('./file-candidate-windows');
    return openWindowsCandidateDirectory(canonicalPath);
  }
  const { openPosixCandidateDirectory } =
    require('./file-candidate-posix') as typeof import('./file-candidate-posix');
  return openPosixCandidateDirectory(canonicalPath);
}
