import { parseDocument } from 'yaml';
import {
  type CompiledSkillWorkflow,
  type CompileSkillWorkflowInput,
  compileWorkflowSnapshot,
  type WorkflowCapability,
  type WorkflowCompileSnapshot,
} from '../workflow-contract';
import { validateWorkflowArguments } from './schema';

let bound: {
  input: Omit<CompileSkillWorkflowInput, 'resolveCapability'>;
  snapshot: WorkflowCompileSnapshot;
  resolver: boolean;
};
let requested: string[] = [];
let originalFacts: [string, WorkflowCapability | undefined][] = [];
let compiled: CompiledSkillWorkflow;
let confirming = false;
self.onmessage = (event: MessageEvent) => {
  try {
    if (event.data.kind === 'validate') {
      self.postMessage({
        kind: 'validation',
        result: validateWorkflowArguments(event.data.schema, event.data.input),
      });
    } else if (event.data.kind === 'compile') {
      confirming = false;
      bound = event.data;
      requested = bound.resolver ? capabilityIds(bound.snapshot) : [];
      self.postMessage({ kind: 'capabilities', ids: requested });
    } else if (event.data.kind === 'confirm') {
      const current = event.data.snapshot as WorkflowCompileSnapshot,
        original = bound.snapshot;
      if (
        JSON.stringify(current.sourceBinding) !== JSON.stringify(original.sourceBinding) ||
        JSON.stringify(current.diagnostics) !== JSON.stringify(original.diagnostics) ||
        current.files.length !== original.files.length ||
        current.files.some(
          (file, index) =>
            file.path !== original.files[index]!.path ||
            !Buffer.from(file.content).equals(Buffer.from(original.files[index]!.content)),
        )
      )
        throw Error('workflow_source_changed');
      confirming = true;
      self.postMessage({ kind: 'capabilities', ids: requested });
    } else if (event.data.kind === 'facts') {
      const facts = new Map<string, WorkflowCapability | undefined>(event.data.facts);
      if (confirming) {
        if (JSON.stringify(event.data.facts) !== JSON.stringify(originalFacts))
          throw Error('workflow_source_changed');
        self.postMessage({ kind: 'result', result: compiled });
      } else {
        originalFacts = event.data.facts;
        compiled = compileWorkflowSnapshot(
          {
            ...bound.input,
            ...(bound.resolver ? { resolveCapability: (id: string) => facts.get(id) } : {}),
          },
          bound.snapshot,
        );
        self.postMessage({ kind: 'result', result: compiled });
      }
    }
  } catch (error) {
    self.postMessage({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Discovery only; the original compiler remains the sole contract/schema admission. */
function capabilityIds(snapshot: WorkflowCompileSnapshot): string[] {
  const file = snapshot.files.find((item) => item.path === 'SKILL.md');
  if (!snapshot.sourceBinding || !file) return [];
  try {
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(file.content)
      .replace(/\r\n?/g, '\n');
    const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
    if (!match) return [];
    const document = parseDocument(match[1]!, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length) return [];
    const manifest: unknown = document.toJS();
    const record = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!record(manifest) || !record(manifest.capabilities)) return [];
    const required = manifest.capabilities.require,
      denied = manifest.capabilities.deny;
    if (
      ![required, denied].every(
        (value) =>
          Array.isArray(value) &&
          value.every((item) => typeof item === 'string' && item.length > 0),
      )
    )
      return [];
    return [...new Set(required as string[])]
      .filter((id) => !(denied as string[]).includes(id))
      .sort();
  } catch {
    return [];
  }
}
