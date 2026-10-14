import type { TuiMcpReadDirectory, TuiMcpSnapshot } from './mcp';

export interface TuiMcpPromptCommand {
  /** Original registry key excludes the slash; selection displays `/${command}`. */
  readonly command: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly promptName: string;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly descriptorDigest: string;
  readonly recordKey: string;
  readonly configDigest: string;
  readonly generation: number;
}
const commandPart = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\s/\\]/u.test(value) &&
  [...value].every((character) => {
    const point = character.codePointAt(0)!;
    return point > 31 && point !== 127;
  });

/** Only Host-verified retained descriptors qualify; this pure registry authorizes no operation. */
export function buildTuiMcpPromptRegistry(
  facts: TuiMcpSnapshot,
  directory: TuiMcpReadDirectory | readonly TuiMcpReadDirectory[],
): ReadonlyMap<string, TuiMcpPromptCommand> {
  const pages: readonly TuiMcpReadDirectory[] = Array.isArray(directory)
    ? directory
    : [directory as TuiMcpReadDirectory];
  const result = new Map<string, TuiMcpPromptCommand>();
  if (
    !pages.length ||
    pages.length > 256 ||
    pages[pages.length - 1]?.nextAfterKey !== null ||
    pages.some(
      (page) =>
        page.family !== 'prompts' ||
        page.sessionId !== facts.sessionId ||
        page.workspaceId !== facts.workspaceId,
    )
  )
    return result;
  const servers = new Map(facts.items.map((server) => [server.id, server]));
  if (servers.size !== facts.items.length) return result;
  const blocked = new Set<string>(),
    recordKeys = new Set<string>();
  let previousCursor = '';
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]!;
    if (
      (page.nextAfterKey !== null && page.nextAfterKey <= previousCursor) ||
      (pageIndex < pages.length - 1 && page.nextAfterKey === null)
    )
      return new Map();
    for (const item of page.items) {
      if (
        recordKeys.has(item.key) ||
        item.key <= previousCursor ||
        (page.nextAfterKey !== null && item.key > page.nextAfterKey)
      )
        return new Map();
      recordKeys.add(item.key);
      const server = servers.get(item.serverId),
        serverName = facts.labels?.[item.serverId];
      if (
        !server?.admitted ||
        !server.selected ||
        !server.available ||
        !item.live ||
        server.configDigest !== item.configDigest ||
        !commandPart(serverName) ||
        item.descriptors.length !== item.descriptorDigests.length
      )
        continue;
      for (let index = 0; index < item.descriptors.length; index++) {
        const descriptor = item.descriptors[index]!,
          promptName = descriptor.name,
          descriptorDigest = item.descriptorDigests[index];
        if (
          !commandPart(promptName) ||
          typeof descriptorDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(descriptorDigest)
        )
          continue;
        const command = `mcp__${serverName}__${promptName}`;
        if (result.has(command) || blocked.has(command)) {
          result.delete(command);
          blocked.add(command);
          continue;
        }
        result.set(command, {
          command,
          serverId: item.serverId,
          serverName,
          promptName,
          descriptor,
          descriptorDigest,
          recordKey: item.key,
          configDigest: item.configDigest,
          generation: item.generation,
        });
      }
    }
    previousCursor = page.nextAfterKey ?? previousCursor;
  }
  return result;
}
