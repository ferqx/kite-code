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
import BlockRenderer from '../src/app/tui/components/BlockRenderer';
import { renderFileSummary } from '../src/app/tui/components/ToolCardBlock';
import { darkTheme } from '../src/app/tui/theme';
import type { OutputBlock } from '../src/app/tui/types';

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

/** 返回指定行文本的生效背景色 / Effective background color for a given line text */
function bgOfLine(summary: string, lineText: string): unknown {
  const out: LabeledLine[] = [];
  collectLabeledLines(renderFileSummary(summary, darkTheme), undefined, out);
  return out.find((l) => l.text === lineText)?.bg;
}

describe('file tool diff summary coloring', () => {
  test('genuine removed/added lines get removed/added backgrounds', () => {
    // formatDiffOutput: 标记紧贴正文（一个空格）/ marker glued to text (one space)
    const summary = 'Added 1 line, removed 1 line\n 1 -foo\n 1 +bar';

    expect(bgOfLine(summary, ' 1 -foo')).toBe(darkTheme.diffRemovedBg);
    expect(bgOfLine(summary, ' 1 +bar')).toBe(darkTheme.diffAddedBg);
  });

  test('plain content with Markdown list items gets no diff backgrounds', () => {
    // formatContentOutput（新建/内容未变/追加）：行号 + 两个空格 + 正文
    // Plain content output (create/unchanged/append): lineNum + two spaces + text.
    // 列表项 "- 嘻嘻嘻" 不是删除行，不得染色。
    // The list item "- 嘻嘻嘻" is not a removed line and must not be painted.
    const summary = 'Wrote 2 lines to notes.md (content unchanged)\n 1  - 嘻嘻嘻\n 2  - 详细信息';

    expect(bgOfLine(summary, ' 1  - 嘻嘻嘻')).toBeUndefined();
    expect(bgOfLine(summary, ' 2  - 详细信息')).toBeUndefined();
  });

  test('list-item context lines in a diff are not painted as removed', () => {
    // 覆写只改末行：列表项是上下文行（两个空格），旧结尾/新结尾是真变更。
    // 修复前两个列表上下文行会被宽松正则误判为删除行。
    // Overwrite changes only the last line: list items are context lines (two
    // spaces); 旧结尾/新结尾 are the genuine removed/added lines. Before the
    // fix, the loose regex painted the two list-item context lines as removed.
    const summary =
      'Added 1 line, removed 1 line\n 1  - 嘻嘻嘻\n 2  - 详细信息\n 3 -旧结尾\n 3 +新结尾';

    expect(bgOfLine(summary, ' 1  - 嘻嘻嘻')).toBeUndefined();
    expect(bgOfLine(summary, ' 2  - 详细信息')).toBeUndefined();
    expect(bgOfLine(summary, ' 3 -旧结尾')).toBe(darkTheme.diffRemovedBg);
    expect(bgOfLine(summary, ' 3 +新结尾')).toBe(darkTheme.diffAddedBg);
  });

  test('"---" frontmatter context line is not painted as removed', () => {
    // YAML frontmatter 分隔线以 "-" 开头，同样不得误判
    // YAML frontmatter fences start with "-", must not be misclassified either.
    const summary = 'Added 1 line, removed 1 line\n 1  ---\n 2 -a\n 2 +b';

    expect(bgOfLine(summary, ' 1  ---')).toBeUndefined();
    expect(bgOfLine(summary, ' 2 -a')).toBe(darkTheme.diffRemovedBg);
    expect(bgOfLine(summary, ' 2 +b')).toBe(darkTheme.diffAddedBg);
  });
});

describe('write_file card title distinguishes create/overwrite/append', () => {
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

  test('append (Appended header) → Append (path)', () => {
    const frame = renderCardTitle('Appended 2 lines to notes.md\n 1  a');
    expect(frame).toContain('Append (notes.md)');
  });

  test('content-unchanged overwrite → Write (path)', () => {
    const frame = renderCardTitle('Wrote 2 lines to notes.md (content unchanged)\n 1  a');
    expect(frame).toContain('Write (notes.md)');
  });
});
