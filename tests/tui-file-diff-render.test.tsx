/**
 * Regression tests — file tool diff summary coloring (renderFileSummary).
 *
 * core 的 diff 格式中，删除/新增行为 `行号 + 一个空格 + 标记（紧贴正文）`，
 * 上下文行与纯内容格式为 `行号 + 两个空格 + 正文`。TUI 的染色正则必须要求
 * 恰好一个空格，否则以 "- " / "+ " 开头的正文（Markdown 列表项、`---`
 * frontmatter）会被误判为删除/新增行并染上红/绿背景。
 *
 * Removed/added lines use "lineNum + one space + marker glued to text";
 * context and plain-content lines use "lineNum + two spaces + text". The TUI
 * coloring regex must require exactly one space, otherwise body text starting
 * with "- " / "+ " (Markdown list items, `---` frontmatter) is misclassified
 * as removed/added and painted with red/green backgrounds.
 *
 * 断言方式：直接检查 renderFileSummary 返回的元素树中每行的
 * backgroundColor 属性（darkTheme.diffRemovedBg / diffAddedBg）。
 * ink-testing-library 的渲染帧不产生 ANSI 颜色转义（非 TTY 色彩检测），
 * 因此走元素树属性比终端转义更精确、且不受环境影响。
 * Assertions inspect per-line backgroundColor props in the element tree
 * returned by renderFileSummary — ink-testing-library frames carry no ANSI
 * color escapes, so prop-level assertions are both precise and env-proof.
 */

import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { ReactElement, ReactNode } from 'react';
import BlockRenderer from '../apps/kite/src/tui/components/BlockRenderer';
import { renderFileSummary } from '../apps/kite/src/tui/components/ToolCardBlock';
import { darkTheme } from '../apps/kite/src/tui/theme';
import type { OutputBlock } from '../apps/kite/src/tui/types';

interface LabeledLine {
  /** 继承自最近祖先 Box 的背景色 / bg inherited from nearest ancestor Box */
  bg: unknown;
  text: string;
}

/** 深度优先收集文本节点及其生效背景色 / DFS-collect text nodes with effective bg */
function collectLabeledLines(node: ReactNode, bg: unknown, out: LabeledLine[]): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ bg, text: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectLabeledLines(child, bg, out);
    return;
  }
  const props = (node as ReactElement<{ backgroundColor?: unknown; children?: ReactNode }>).props;
  const nextBg = props.backgroundColor !== undefined ? props.backgroundColor : bg;
  collectLabeledLines(props.children, nextBg, out);
}

/** 返回指定文本节点的生效背景色 — 按代码正文匹配（行号前缀已被拆分） */
function bgOfLine(summary: string, codeText: string): unknown {
  const out: LabeledLine[] = [];
  collectLabeledLines(renderFileSummary(summary, darkTheme), undefined, out);
  return out.find((l) => l.text === codeText)?.bg;
}

describe('file tool diff summary coloring', () => {
  test('genuine removed/added lines get removed/added backgrounds', () => {
    const summary = 'Added 1 line, removed 1 line\n 1 -foo\n 1 +bar';
    expect(bgOfLine(summary, 'foo')).toBe(darkTheme.diffRemovedBg);
    expect(bgOfLine(summary, 'bar')).toBe(darkTheme.diffAddedBg);
  });

  test('plain content with Markdown list items gets no diff backgrounds', () => {
    const summary = 'Wrote 2 lines to notes.md (content unchanged)\n 1  - 嘻嘻嘻\n 2  - 详细信息';
    expect(bgOfLine(summary, '- 嘻嘻嘻')).toBeUndefined();
    expect(bgOfLine(summary, '- 详细信息')).toBeUndefined();
  });

  test('list-item context lines in a diff are not painted as removed', () => {
    const summary =
      'Added 1 line, removed 1 line\n 1  - 嘻嘻嘻\n 2  - 详细信息\n 3 -旧结尾\n 3 +新结尾';
    expect(bgOfLine(summary, '- 嘻嘻嘻')).toBeUndefined();
    expect(bgOfLine(summary, '- 详细信息')).toBeUndefined();
    expect(bgOfLine(summary, '旧结尾')).toBe(darkTheme.diffRemovedBg);
    expect(bgOfLine(summary, '新结尾')).toBe(darkTheme.diffAddedBg);
  });

  test('"---" frontmatter context line is not painted as removed', () => {
    const summary = 'Added 1 line, removed 1 line\n 1  ---\n 2 -a\n 2 +b';
    expect(bgOfLine(summary, '---')).toBeUndefined();
    expect(bgOfLine(summary, 'a')).toBe(darkTheme.diffRemovedBg);
    expect(bgOfLine(summary, 'b')).toBe(darkTheme.diffAddedBg);
  });

  test('create (Wrote N lines) gets green background on all content lines', () => {
    const summary = 'Wrote 3 lines to notes.md\n 1  line one\n 2  line two\n 3  line three';
    expect(bgOfLine(summary, 'line one')).toBe(darkTheme.diffAddedBg);
    expect(bgOfLine(summary, 'line two')).toBe(darkTheme.diffAddedBg);
    expect(bgOfLine(summary, 'line three')).toBe(darkTheme.diffAddedBg);
  });

  test('content-unchanged overwrite keeps dim (no background)', () => {
    const summary = 'Wrote 2 lines to notes.md (content unchanged)\n 1  a\n 2  b';
    expect(bgOfLine(summary, 'a')).toBeUndefined();
    expect(bgOfLine(summary, 'b')).toBeUndefined();
  });
});

describe('write_file card title distinguishes create/overwrite', () => {
  function renderCardTitle(summary: string, path = 'notes.md'): string {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'write_file',
      args: { path },
      status: 'done',
      expanded: true,
      summary,
      detail: `(${path})`,
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    return lastFrame() ?? '';
  }

  test('overwrite (diff summary) → Write (path)', () => {
    const frame = renderCardTitle('Added 1 line, removed 1 line\n 1 -a\n 1 +b');
    expect(frame).toContain('Write (notes.md)');
    expect(frame).not.toContain('Create (notes.md)');
  });

  test('create (Wrote header) → Create (path)', () => {
    const frame = renderCardTitle('Wrote 3 lines to notes.md\n 1  a', 'notes.md');
    expect(frame).toContain('Create (notes.md)');
    expect(frame).not.toContain('Write (notes.md)');
  });

  test('content-unchanged overwrite → Write (path)', () => {
    const frame = renderCardTitle('Wrote 2 lines to notes.md (content unchanged)\n 1  a');
    expect(frame).toContain('Write (notes.md)');
  });
});
