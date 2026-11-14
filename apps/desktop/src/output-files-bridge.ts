import type { OutputFileSummary, OutputFilesPage, OutputFileTarget } from '@kite-ai/client';
import type { InputRequest } from './input';
export type PdfSelection = {
  kind: 'pdf';
  page: number;
  pageBasis: 'pdf-rendered';
  scope: 'page' | 'region' | 'text';
  rects: { x: number; y: number; width: number; height: number }[];
  text?: string;
  start?: { item: number; offset: number };
  end?: { item: number; offset: number };
};
export type OfficeSelection =
  | PdfSelection
  | {
      kind: 'word';
      start: { path: string; offset: number };
      end: { path: string; offset: number };
      text: string;
    }
  | {
      kind: 'excel';
      sheet: string;
      range: string;
      cells: { path: string; address: string; value: string; formula?: string }[];
    }
  | {
      kind: 'word';
      scope: 'page';
      pageBasis: 'html-preview';
      page: number;
      layoutGeneration: number;
      blocks: { path: string; text: string }[];
    }
  | { kind: 'excel'; scope: 'sheet'; sheet: string }
  | { kind: 'powerpoint'; slide: number; objectPath?: string; text?: string };
export type OfficeEditorReference = { editorId: string; revision: number; sourceHash: string };
export type OfficeEditContext = {
  sourceHash: string;
  selection?: OfficeSelection;
  editor?: OfficeEditorReference;
};
export type OfficeRequestOutcome = { status: 'accepted' | 'failed' | 'unknown'; message?: string };
export type OfficeInlineRequest = { requestId: string; prompt: string; context: OfficeEditContext };
/** Display-only identity; never edit context or authorization. */
export type OfficeExcelSelectionView = { selectionSerial: number; activeAddress: string };
export type OfficePreviewInteraction = {
  previewId: string;
  generation: number;
  sourceHash: string;
  target: OutputFileTarget;
  selection: OfficeSelection | null;
  excelSelection?: OfficeExcelSelectionView;
  currentSlide?: number;
  slideCount?: number;
  floatingRequest?: number;
  floatingSelection?: OfficeSelection;
  inlineRequest?: OfficeInlineRequest;
  requestOpen?: boolean;
  notes?: string;
  presentation?: boolean;
  zoom?: number | 'fit';
};
export type LocalOfficePreviewInteraction = Omit<OfficePreviewInteraction, 'target'> & {
  handleId: string;
};
export type LocalOfficeRequest = { handleId: string; previewId: string; requestId: string };
export type OfficePreviewControl =
  | { kind: 'request-edit' }
  | { kind: 'locate-selection'; selectionSerial: number }
  | { kind: 'zoom'; value: number | 'fit' }
  | { kind: 'slide'; value: number }
  | { kind: 'presentation'; value: boolean };
export type NativeOutputRequest =
  | ({
      method: 'localPreview.submit';
      generation: number;
      sessionId: string;
      intent: InputRequest;
    } & LocalOfficeRequest)
  | {
      method: 'localPreview.interaction';
      generation: number;
      handleId: string;
      previewId: string;
      consumeRequest?: boolean;
    }
  | ({
      method: 'localPreview.request.result';
      generation: number;
      outcome: OfficeRequestOutcome;
    } & LocalOfficeRequest)
  | {
      method: 'localPreview.open';
      generation: number;
      handleId: string;
      previewId: string;
      bounds: { x: number; y: number; width: number; height: number };
    }
  | { method: 'localPreview.release' | 'localPreview.check'; generation: number; handleId: string }
  | {
      method: 'outputs.preview.request.result';
      generation: number;
      previewId: string;
      requestId: string;
      outcome: OfficeRequestOutcome;
    }
  | {
      method: 'outputs.preview.interaction';
      generation: number;
      previewId: string;
      consumeRequest?: boolean;
    }
  | {
      method: 'outputs.preview.control';
      generation: number;
      previewId: string;
      control: OfficePreviewControl;
    }
  | {
      method: 'outputs.office.preview';
      generation: number;
      target: OutputFileTarget;
      editorId: string;
      revision: number;
      previewId: string;
      bounds: { x: number; y: number; width: number; height: number };
      initialSlide?: number;
      initialZoom?: number | 'fit';
    }
  | {
      method: 'outputs.office.save';
      generation: number;
      target: OutputFileTarget;
      editorId: string;
      revision: number;
    }
  | {
      method: 'outputs.retry';
      generation: number;
      scope: { storeId: string; sessionId: string };
      collectionId: string;
      expectedRevision: string;
    }
  | {
      method: 'outputs.query';
      generation: number;
      scope: { storeId: string; sessionId: string };
      runId?: string;
      beforeKey?: string;
      collectionBeforeKey?: string;
      limit?: number;
    }
  | { method: 'outputs.save' | 'outputs.info'; generation: number; target: OutputFileTarget }
  | {
      method: 'outputs.preview.open';
      generation: number;
      previewId: string;
      target: OutputFileTarget;
      bounds: { x: number; y: number; width: number; height: number };
    }
  | { method: 'outputs.preview.close'; generation: number; previewId: string }
  | {
      method: 'outputs.preview.bounds';
      generation: number;
      previewId: string;
      bounds: { x: number; y: number; width: number; height: number };
    }
  | { method: 'outputs.pdf.page'; generation: number; target: OutputFileTarget; page: number }
  | {
      method: 'input.files.fromOutput';
      generation: number;
      id: string;
      target: OutputFileTarget;
      context?: OfficeEditContext;
    };
export type NativeOutputResult =
  | { kind: 'localPreview.interaction'; interaction: LocalOfficePreviewInteraction }
  | {
      kind: 'messageFile.preview';
      handleId: string;
      name: string;
      mediaType: string;
      storeId: string;
      sessionId: string;
    }
  | { kind: 'outputs.preview.interaction'; interaction: OfficePreviewInteraction }
  | {
      kind: 'outputs.pdf.page';
      pdf: { page: number; totalPages: number; mediaType: 'image/png'; data: string };
    }
  | { kind: 'outputs.info'; file: OutputFileSummary }
  | { kind: 'outputs.page'; page: OutputFilesPage }
  | { kind: 'outputs.saved'; cancelled: boolean }
  | { kind: 'outputs.preview'; status: 'ready' | 'unavailable' };
export function isOutputFileTarget(value: unknown): value is OutputFileTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'fileId,locator,sessionId,storeId') return false;
  if (
    ![item.storeId, item.sessionId, item.fileId].every(
      (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v),
    )
  )
    return false;
  if (!item.locator || typeof item.locator !== 'object' || Array.isArray(item.locator))
    return false;
  const locator = item.locator as Record<string, unknown>;
  return locator.kind === 'legacy-operation'
    ? Object.keys(locator).sort().join(',') === 'executionId,kind' &&
        typeof locator.executionId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(locator.executionId)
    : (locator.kind === 'delivery' || locator.kind === 'legacy-inherited') &&
        Object.keys(locator).sort().join(',') === 'key,kind' &&
        typeof locator.key === 'string' &&
        locator.key.length > 0 &&
        locator.key.length <= 1024;
}

export type OutputDraftFile = {
  id: string;
  name: string;
  ownerRunId?: string;
  target: OutputFileTarget;
  context?: OfficeEditContext;
};
export function readOutputDraftFiles(
  value: unknown,
  options: { allowLegacyExcelRanges?: boolean } = {},
): readonly OutputDraftFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw Error('output_draft_invalid');
  for (const entry of value)
    if (
      !entry ||
      typeof entry !== 'object' ||
      ![
        'id,name,target',
        'id,name,ownerRunId,target',
        'context,id,name,target',
        'context,id,name,ownerRunId,target',
      ].includes(Object.keys(entry).sort().join(',')) ||
      typeof entry.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ||
      typeof entry.name !== 'string' ||
      !entry.name ||
      entry.name.length > 512 ||
      (entry.ownerRunId !== undefined &&
        (typeof entry.ownerRunId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(entry.ownerRunId))) ||
      !isOutputFileTarget(entry.target) ||
      (entry.context !== undefined &&
        !isOfficeEditContext(entry.context) &&
        !(options.allowLegacyExcelRanges && isLegacyExcelDraftContext(entry.context)))
    )
      throw Error('output_draft_invalid');
  if (new Set(value.map((entry) => entry.id)).size !== value.length)
    throw Error('output_draft_invalid');
  return value;
}

/** Read compatibility only. Never permits importing or submitting an old sparse scope. */
function isLegacyExcelDraftContext(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  if (!isOfficeEditContext({ ...context, selection: undefined })) return false;
  const q = context.selection as Record<string, unknown>;
  const str = (x: unknown, n: number) =>
    typeof x === 'string' && x.length <= n && !x.includes(String.fromCharCode(0));
  // Historical budget was UTF-16 length, not bytes. Preserve only this bounded old shape.
  return (
    !!q &&
    typeof q === 'object' &&
    !Array.isArray(q) &&
    JSON.stringify(q).length <= 32768 &&
    q.kind === 'excel' &&
    Object.keys(q).sort().join(',') === 'cells,kind,range,sheet' &&
    str(q.sheet, 128) &&
    typeof q.range === 'string' &&
    /^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/.test(q.range) &&
    Array.isArray(q.cells) &&
    q.cells.length <= 256 &&
    q.cells.every(
      (c) =>
        c &&
        typeof c === 'object' &&
        !Array.isArray(c) &&
        Object.keys(c).every((k) => ['path', 'address', 'value', 'formula'].includes(k)) &&
        str(c.path, 512) &&
        c.path.startsWith('/') &&
        typeof c.address === 'string' &&
        /^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(c.address) &&
        str(c.value, 4096) &&
        (c.formula === undefined || str(c.formula, 4096)),
    )
  );
}

/** Locations are bounded, untrusted document context, never executable host commands. */
export function isOfficeEditContext(value: unknown): value is OfficeEditContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !['sourceHash', 'selection', 'editor'].includes(k)) ||
    typeof v.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sourceHash)
  )
    return false;
  if (v.editor !== undefined) {
    const e = v.editor as Record<string, unknown>;
    if (
      !e ||
      typeof e !== 'object' ||
      Object.keys(e).sort().join(',') !== 'editorId,revision,sourceHash' ||
      typeof e.editorId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(e.editorId) ||
      !Number.isSafeInteger(e.revision) ||
      Number(e.revision) < 0 ||
      e.sourceHash !== v.sourceHash
    )
      return false;
  }
  if (v.selection === undefined) return true;
  const q = v.selection as Record<string, unknown>;
  const str = (x: unknown, n: number) =>
    typeof x === 'string' && x.length <= n && !x.includes(String.fromCharCode(0));
  const path = (x: unknown) => str(x, 512) && (x as string).startsWith('/');
  if (!q || typeof q !== 'object' || Array.isArray(q) || JSON.stringify(q).length > 32768)
    return false;
  if (q.kind === 'pdf') {
    const point = (v: unknown) => {
      const p = v as Record<string, unknown>;
      return (
        !!p &&
        typeof p === 'object' &&
        Object.keys(p).sort().join(',') === 'item,offset' &&
        Number.isSafeInteger(p.item) &&
        Number(p.item) >= 0 &&
        Number(p.item) < 10000 &&
        Number.isSafeInteger(p.offset) &&
        Number(p.offset) >= 0 &&
        Number(p.offset) <= 16000
      );
    };
    return (
      v.editor === undefined &&
      q.pageBasis === 'pdf-rendered' &&
      Number.isSafeInteger(q.page) &&
      Number(q.page) >= 1 &&
      Number(q.page) <= 500 &&
      ['page', 'region', 'text'].includes(String(q.scope)) &&
      Object.keys(q).sort().join(',') ===
        (q.scope === 'text'
          ? 'end,kind,page,pageBasis,rects,scope,start,text'
          : 'kind,page,pageBasis,rects,scope') &&
      Array.isArray(q.rects) &&
      q.rects.length <= 256 &&
      (q.scope === 'page' ? q.rects.length === 0 : q.rects.length > 0) &&
      q.rects.every(
        (r) =>
          r &&
          typeof r === 'object' &&
          Object.keys(r).sort().join(',') === 'height,width,x,y' &&
          Object.values(r).every(
            (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1,
          ) &&
          r.width > 0 &&
          r.height > 0 &&
          r.x + r.width <= 1.000001 &&
          r.y + r.height <= 1.000001,
      ) &&
      (q.scope !== 'text' || (point(q.start) && point(q.end) && str(q.text, 16000) && !!q.text))
    );
  }
  if (q.kind === 'word') {
    if (q.scope === 'page') {
      if (new TextEncoder().encode(JSON.stringify(q)).byteLength > 32768) return false;
      const seen = new Set<string>();
      return (
        Object.keys(q).sort().join(',') === 'blocks,kind,layoutGeneration,page,pageBasis,scope' &&
        q.pageBasis === 'html-preview' &&
        Number.isSafeInteger(q.page) &&
        Number(q.page) >= 1 &&
        Number(q.page) <= 500 &&
        Number.isSafeInteger(q.layoutGeneration) &&
        Number(q.layoutGeneration) >= 1 &&
        Array.isArray(q.blocks) &&
        q.blocks.length > 0 &&
        q.blocks.length <= 256 &&
        q.blocks.every((block) => {
          if (
            !block ||
            typeof block !== 'object' ||
            Array.isArray(block) ||
            Object.keys(block).sort().join(',') !== 'path,text' ||
            !path(block.path) ||
            !/^\/body\//.test(block.path) ||
            /[\r\n]/.test(block.path) ||
            !str(block.text, 16000) ||
            seen.has(block.path)
          )
            return false;
          seen.add(block.path);
          return true;
        })
      );
    }
    const point = (x: unknown) => {
      const p = x as Record<string, unknown>;
      return (
        p &&
        typeof p === 'object' &&
        Object.keys(p).sort().join(',') === 'offset,path' &&
        path(p.path) &&
        Number.isSafeInteger(p.offset) &&
        Number(p.offset) >= 0 &&
        Number(p.offset) <= 10000000
      );
    };
    return (
      Object.keys(q).sort().join(',') === 'end,kind,start,text' &&
      !!point(q.start) &&
      !!point(q.end) &&
      str(q.text, 16000)
    );
  }
  if (q.kind === 'excel') {
    if (new TextEncoder().encode(JSON.stringify(q)).byteLength > 32768) return false;
    if (!str(q.sheet, 128) || !(q.sheet as string).length || /[\r\n]/.test(q.sheet as string))
      return false;
    if (q.scope === 'sheet') return Object.keys(q).sort().join(',') === 'kind,scope,sheet';
    const address = (value: unknown) => {
      if (typeof value !== 'string') return null;
      const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value);
      if (!match) return null;
      let col = 0;
      for (const c of match[1]!) col = col * 26 + c.charCodeAt(0) - 64;
      const row = Number(match[2]);
      return col <= 16384 && row <= 1048576 ? { col, row } : null;
    };
    if (Object.keys(q).sort().join(',') !== 'cells,kind,range,sheet' || typeof q.range !== 'string')
      return false;
    const parts = q.range.split(':');
    if (parts.length > 2) return false;
    const low = address(parts[0]),
      high = address(parts[1] ?? parts[0]);
    if (!low || !high || low.col > high.col || low.row > high.row) return false;
    const width = high.col - low.col + 1,
      area = width * (high.row - low.row + 1);
    if (area > 256 || !Array.isArray(q.cells) || q.cells.length !== area) return false;
    return q.cells.every((c, i) => {
      if (
        !c ||
        typeof c !== 'object' ||
        Array.isArray(c) ||
        !['address,path,value', 'address,formula,path,value'].includes(
          Object.keys(c).sort().join(','),
        ) ||
        !str(c.value, 4096) ||
        (c.formula !== undefined && !str(c.formula, 4096))
      )
        return false;
      const point = address(c.address);
      return (
        point?.row === low.row + Math.floor(i / width) &&
        point.col === low.col + (i % width) &&
        c.path === `/${q.sheet}/${c.address}` &&
        path(c.path)
      );
    });
  }
  if (q.kind === 'powerpoint')
    return (
      Object.keys(q).every((k) => ['kind', 'slide', 'objectPath', 'text'].includes(k)) &&
      Number.isSafeInteger(q.slide) &&
      Number(q.slide) >= 1 &&
      Number(q.slide) <= 10000 &&
      (q.objectPath === undefined || path(q.objectPath)) &&
      (q.text === undefined || str(q.text, 16000))
    );
  return false;
}

export function outputDraftUri(file: Pick<OutputDraftFile, 'id' | 'target' | 'context'>): string {
  return `output-file:${file.target.fileId}${file.context ? `:${file.id}` : ''}`;
}
export function outputDraftLabel(
  file: Pick<OutputDraftFile, 'name' | 'ownerRunId' | 'context'>,
): string {
  const selection = file.context?.selection;
  const location = selection ? officeSelectionLabel(selection) : '';
  return [
    file.name,
    file.context?.editor
      ? `副本 ${file.context.editor.revision}`
      : `基于${file.ownerRunId ? `轮次 ${file.ownerRunId.slice(0, 8)}` : '历史文件'}`,
    location,
    file.context && !isOfficeEditContext(file.context) && isLegacyExcelDraftContext(file.context)
      ? '范围需重选'
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A concise display label only; target and source identity remain host-owned. */
export function officeSelectionLabel(selection: OfficeSelection): string {
  if (selection.kind === 'pdf')
    return `PDF 第 ${selection.page} 页${selection.scope === 'text' ? '选中文字' : selection.scope === 'region' ? '选定区域' : ''}`;
  if (selection.kind === 'excel')
    return 'scope' in selection
      ? `工作表 ${selection.sheet}`
      : `${selection.sheet}!${selection.range}`;
  if (selection.kind === 'powerpoint') return `第 ${selection.slide} 页`;
  return 'scope' in selection ? `预览第 ${selection.page} 页正文` : '选中文字';
}
