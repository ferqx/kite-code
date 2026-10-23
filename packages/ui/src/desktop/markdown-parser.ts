import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { type Processor, unified } from 'unified';

export type DesktopMarkdownTree = ReturnType<NonNullable<Processor['parser']>>;
const fixedProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();
/** Pure fixed syntax only; safe in a Worker without React, DOM, files or host authority. */
export const parseDesktopMarkdown = (text: string): DesktopMarkdownTree =>
  fixedProcessor.parse(text);
