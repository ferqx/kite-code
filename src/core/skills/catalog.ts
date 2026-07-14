import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSnapshot } from '@/core/capabilities/catalog';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';
import type { SkillManifest, SkillScanOptions } from './types';
import { type CompiledSkillWorkflow, compileSkillWorkflow } from './workflow';

export interface SkillCatalogEntry extends CompiledSkillWorkflow {
  /** A lower-priority source with this name is diagnosable but never activatable. */
  shadowedBy?: string;
}

export interface SkillCatalogSnapshot {
  revision: string;
  capabilities: CapabilitySnapshot;
  entries: SkillCatalogEntry[];
}

export interface RefreshSkillCatalogOptions {
  resolveCapability?: (capabilityId: string) => CapabilityDescriptor | undefined;
}

interface SourceRoot {
  path: string;
  source: 'project' | 'user';
  origin: '.kite-code' | '.agents';
}

function roots(options: SkillScanOptions): SourceRoot[] {
  return [
    { path: options.projectKiteCodeSkillsDir, source: 'project', origin: '.kite-code' },
    { path: options.projectAgentsSkillsDir, source: 'project', origin: '.agents' },
    { path: options.userKiteCodeSkillsDir, source: 'user', origin: '.kite-code' },
    { path: options.userAgentsSkillsDir, source: 'user', origin: '.agents' },
  ];
}

/**
 * Discover every candidate directory. Unlike the retired prompt loader, a
 * malformed candidate remains visible as an unavailable capability with a
 * structured diagnostic rather than disappearing from the catalog.
 */
export function refreshSkillCatalog(
  options: SkillScanOptions,
  refreshOptions: RefreshSkillCatalogOptions = {},
): SkillCatalogSnapshot {
  const entries: SkillCatalogEntry[] = [];
  const selected = new Map<string, SkillCatalogEntry>();
  for (const root of roots(options)) {
    if (!existsSync(root.path)) continue;
    let children: string[] = [];
    try {
      children = readdirSync(root.path).sort((left, right) => left.localeCompare(right));
    } catch {
      // A root itself has no stable Skill identity, so there is no descriptor
      // to register. Individual skill directory failures are always retained.
      continue;
    }
    for (const child of children) {
      const directory = join(root.path, child);
      try {
        if (!statSync(directory).isDirectory()) continue;
      } catch {
        continue;
      }
      const entry: SkillCatalogEntry = compileSkillWorkflow({
        skillDir: directory,
        source: root.source,
        origin: root.origin,
        resolveCapability: refreshOptions.resolveCapability,
      });
      const canonicalName = entry.contract?.name ?? child;
      const winner = selected.get(canonicalName);
      if (winner) {
        entry.shadowedBy = winner.sourcePath;
        entry.diagnostics.push({
          code: 'invalid_field',
          message: `Skill '${canonicalName}' is shadowed by higher-priority source ${winner.sourcePath}.`,
          path: resolve(directory),
        });
        entry.descriptor = {
          ...entry.descriptor,
          availability: 'unavailable',
          diagnostics: [...entry.descriptor.diagnostics, `shadowed: ${winner.sourcePath}`],
        };
      } else {
        selected.set(canonicalName, entry);
      }
      entries.push(entry);
    }
  }
  const visible = [...selected.values()].map((entry) => entry.descriptor);
  const capabilities = createSnapshot(visible);
  return { revision: capabilities.revision, capabilities, entries };
}

export function findSkillCatalogEntry(
  catalog: SkillCatalogSnapshot,
  skillId: string,
): SkillCatalogEntry | undefined {
  return catalog.entries.find(
    (entry) => !entry.shadowedBy && entry.descriptor.capabilityId === skillId,
  );
}

/** Presentation metadata for TUI discovery, derived only from compiled contracts. */
export function scanCompiledSkillManifests(options: SkillScanOptions): SkillManifest[] {
  return refreshSkillCatalog(options).entries.flatMap((entry) =>
    entry.contract && !entry.shadowedBy && entry.descriptor.availability === 'available'
      ? [
          {
            name: entry.contract.name,
            description: entry.contract.description,
            source: entry.source,
            origin: entry.origin,
          },
        ]
      : [],
  );
}
