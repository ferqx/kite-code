import { createHash } from 'node:crypto';
import { SkillError, type SkillSummary } from './index';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const builtinOfficeSkillId = 'office-documents';
const body = `---
name: office-documents
description: Create, edit and deliver DOCX, XLSX, PPTX and PDF files using the bundled office runtime.
---
# Office documents

Read the declared format resource before starting: docx.md, xlsx.md, pptx.md or pdf.md.
The runtime is bundled with Kite. Never install packages, OfficeCLI, Python or a second Bun runtime. Use the host-provided KITE_DOCUMENTS_HELPER with the existing KITE_DOCUMENTS_BUN executable. KITE_OFFICECLI is the fixed upstream binary path. These paths and KITE_OUTPUT_DIR are data supplied by the host, not permission grants.

Keep working copies in the workspace. KITE_OUTPUT_DIR is unique to the current Shell execution: only put completed deliverables there. Do not edit across Shell calls in that directory. Kite attaches completed files automatically; no delivery tool is needed. Use one batch and finish validation and export in the same Shell call. The helper --out is the destination of a newly created file, never an in-place edit: use a fresh workspace path for an intermediate working copy, or a fresh KITE_OUTPUT_DIR path for a final deliverable. Do not overwrite the input or an existing output. When no further edits are needed, export directly to KITE_OUTPUT_DIR rather than creating an intermediate copy just to move it.


Use POSIX-compatible shell syntax unless the execution environment explicitly guarantees another shell. Do not assume Bash process substitution, arrays or [[ ... ]] under /bin/sh. Use quoted paths, quoted heredocs and workspace files for intermediate checks; run additional comparisons on working copies before final export. Preserve command failures: never hide them with || true or a final successful command.

A successful helper message or an output pathname is not proof of delivery: the whole producer Shell must finish successfully before automatic collection can start. After a nonzero exit, that attempt's files are not collected; after an unknown result, inspect the existing execution status before retrying. Do not claim saved, attached or delivered from an earlier helper success. Recover from an inspected, still-available workspace source, not a previous Shell's temporary KITE_OUTPUT_DIR. Correct the failed step, validate, then export to a fresh path in the new Shell's current KITE_OUTPUT_DIR and check its terminal result. Do not repeat mutations blindly or recreate an unreadable source from conversation alone. If recovery or collection cannot be confirmed, report the specific incomplete step; successful generation, structural checks, collection and visual inspection are separate claims. Use existing tool results and any available collection feedback; no new tool is required.

Example: "$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" office --format docx --input ops.json --out "$KITE_OUTPUT_DIR/report.docx"
For edits replace --format with --source pointing to a working copy. --input - accepts JSON on stdin. Operations are the upstream OfficeCLI batch operation array, not a new DSL.


For unfamiliar OfficeCLI commands or flags, inspect the bundled binary's --help, then the discovered subcommand's --help before use (for example, "$KITE_OFFICECLI" view --help). The helper accepts only its documented --format/--source, --input and --out arguments; upstream command flags belong to OfficeCLI, not the helper. Do not guess modes or property names; if local help does not establish support, report that limitation rather than inventing an operation.

Before editing, identify the requested changes and content that must stay unchanged. Verify the original input's bytes remain unchanged using node:crypto with the existing KITE_DOCUMENTS_BUN, rather than assuming platform utilities such as sha256sum exist; verify the new output's requested changes and relevant unchanged text, formulas, structure and formatting semantically. A different ZIP container or XML serialization alone is not a content regression, and structural validation alone does not prove the requested edit or preservation. Check working copies before final export; do not ignore real content differences to pass validation. Inspect added and removed package parts before asserting identical part sets; a newly added, known editor-property part requires an explained exact property set plus its unique matching content-type and relationship. Reject unexplained added or removed parts; this is not a blanket allowance for new parts. Explain edit-generated metadata differences before accepting them: scope each exception to the exact part, node, namespace and field, validate its new value, and preserve field identity and type. An edited paragraph's text-revision marker or a known editor modification timestamp may change; do not exempt neighboring nodes, whole metadata parts or unexplained differences. Continue checking all other content, styles, tables and relationships.

Structural validation is not visual inspection. Inspect layout when possible; describe any unverified layout honestly. Never claim Excel-equivalent full recalculation or arbitrary PDF paragraph editing. Missing runtime assets are a packaging error; do not download replacements at task time.
`;
const resources: Record<string, string> = {
  'docx.md': `# DOCX
Create in one Shell call; the quoted heredoc is the upstream batch array:
\`\`\`sh
"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" office --format docx --input - --out "$KITE_OUTPUT_DIR/report.docx" <<'JSON'
[{"command":"add","parent":"/body","type":"paragraph","props":{"text":"中文报告"}}]
JSON
\`\`\`
Read a working input: "$KITE_OFFICECLI" view "$WORKING_INPUT" text --max-lines 80 --json. For structure use view "$WORKING_INPUT" outline --max-lines 80 --json. Edit with the same helper command, replace --format docx with --source "$WORKING_INPUT", and use [{"command":"set","path":"/body/p[1]","props":{"text":"修订正文"}}]. Use observed node paths when the actual document differs.
Helper creates/copies, batches, validates and exports. Do not run OfficeCLI install or resident/open/watch. Use headings and modest tables; structural validate is not pagination/typography inspection.`,
  'xlsx.md': `# XLSX
Create and check a common formula in one call:
\`\`\`sh
"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" office --format xlsx --input - --out "$KITE_OUTPUT_DIR/budget.xlsx" <<'JSON'
[{"command":"set","path":"/Sheet1/A1","props":{"value":"2"}},{"command":"set","path":"/Sheet1/A2","props":{"value":"3"}},{"command":"set","path":"/Sheet1/A3","props":{"formula":"SUM(A1:A2)"}}]
JSON
\`\`\`
Read: "$KITE_OFFICECLI" view "$WORKING_INPUT" text --range 'Sheet1!A1:C10' --max-lines 20 --json. Edit by replacing --format xlsx with --source "$WORKING_INPUT" and submitting set operations for the observed sheet/cells. Write values before formulas. Helper checks validate plus view issues --type content --json. formula_eval_error and formula_ref_missing_sheet block delivery. Unevaluated/stale caches or incomplete inspection retain calculation-not-fully-verified warnings. No issues does not prove Excel-wide recalculation: external links, unsupported functions and old caches are not guaranteed. Independently check representative totals.`,
  'pptx.md': `# PPTX
Create a slide in one call:
\`\`\`sh
"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" office --format pptx --input - --out "$KITE_OUTPUT_DIR/deck.pptx" <<'JSON'
[{"command":"add","parent":"/","type":"slide"},{"command":"add","parent":"/slide[1]","type":"shape","props":{"text":"中文演示","x":"1cm","y":"1cm","width":"15cm","height":"3cm"}}]
JSON
\`\`\`
Read: "$KITE_OFFICECLI" view "$WORKING_INPUT" outline --max-lines 60 --json. Edit with --source "$WORKING_INPUT" instead of --format pptx and operations such as [{"command":"set","path":"/slide[1]/shape[1]","props":{"text":"修订标题"}}], after verifying the actual node. JSON paths avoid Git Bash slash rewriting. Review hierarchy, overflow, contrast and image placement separately. HTML is not PowerPoint rendering equivalence; animations and complex 3D are not promised.`,
  'pdf.md': `# PDF
Create a fixed-template Chinese document:
\`\`\`sh
"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" pdf --input - --out "$KITE_OUTPUT_DIR/report.pdf" <<'JSON'
{"operation":"create","pages":[{"blocks":[{"type":"title","text":"中文报告"},{"type":"text","text":"正文与 English。"}]}]}
JSON
\`\`\`
Use the same command with --input spec.json, or stdin JSON, for edits. Merge: {"operation":"merge","sources":["a.pdf","b.pdf"]}. Reorder/delete/split: {"operation":"edit","source":"input.pdf","pages":[2,0]}. Rotate/overlay: {"operation":"edit","source":"input.pdf","rotations":[{"page":0,"degrees":90}],"overlays":[{"page":0,"text":"修订","x":50,"y":50}]}. Pages are zero-based. Images use blocks or overlays with path,width,height; overlays also need page,x,y. Fields use {"operation":"edit","source":"form.pdf","fields":{"name":"中文","ok":true}}; text/checkbox/dropdown/option-list are supported, but not form filling together with page selection.
Create uses A4, fixed style, embedded bundled font, true-width wrapping and explicit pages. layout_overflow rejects capacity excess rather than clipping. Complex tables belong in DOCX/XLSX. No arbitrary original paragraph replacement or reflow. Read/preview PDFs through the existing read_file PDF page interface, not OfficeCLI; retain page budgets and inspect the page images when layout matters.`,
};
const version = hash(JSON.stringify({ body, resources }));
const summary: SkillSummary = {
  id: `builtin:${builtinOfficeSkillId}`,
  version,
  name: builtinOfficeSkillId,
  description:
    'Create, edit and deliver DOCX, XLSX, PPTX and PDF files using the bundled office runtime.',
  location: `builtin:${builtinOfficeSkillId}/SKILL.md`,
  requiredCapabilities: [],
};
export function createBuiltinOfficeSkillSource() {
  let discovered = false,
    closed = false;
  const check = (id: string, expected?: string) => {
    if (closed) throw new SkillError('knowledge_source_closed');
    if (!discovered || id !== summary.id) throw new SkillError('skill_not_discovered');
    if (expected !== undefined && expected !== version)
      throw new SkillError('skill_version_changed');
  };
  return {
    async list() {
      if (closed) throw new SkillError('knowledge_source_closed');
      discovered = true;
      return { entries: [structuredClone(summary)], errors: [] };
    },
    async load(input: { id: string; version?: string; availableCapabilities?: readonly string[] }) {
      check(input.id, input.version);
      return {
        ...structuredClone(summary),
        body,
        resources: Object.keys(resources).map((path) => ({
          path,
          id: hash(`${summary.id}:${version}:${path}`),
        })),
      };
    },
    async readDocument(input: { id: string; version: string; maxTextBytes: number }) {
      check(input.id, input.version);
      if (!Number.isSafeInteger(input.maxTextBytes) || input.maxTextBytes < 1)
        throw new SkillError('invalid_skill_configuration');
      if (Buffer.byteLength(body) > input.maxTextBytes) throw new SkillError('skill_text_limit');
      return { ...structuredClone(summary), body };
    },
    async readResource(input: {
      skillId: string;
      version: string;
      path: string;
      availableCapabilities?: readonly string[];
    }) {
      check(input.skillId, input.version);
      if (!Object.hasOwn(resources, input.path))
        throw new SkillError('skill_resource_not_declared');
      const text = resources[input.path]!;
      return {
        id: hash(`${summary.id}:${version}:${input.path}`),
        version: hash(text),
        body: text,
      };
    },
    async dispose() {
      closed = true;
    },
  };
}
