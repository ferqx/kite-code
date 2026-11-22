import type { Message, WebFetchBatchPage } from './types';

type WebFetchBatchDisplay = {
  readonly pages: readonly WebFetchBatchPage[];
  readonly succeeded: number;
  readonly label: string;
};

/** Read only host-projected facts, never infer a batch outcome from requests or page body text. */
export function webFetchBatchDisplay(message: Message): WebFetchBatchDisplay | undefined {
  const input = message.webFetchBatch?.pages;
  if (
    message.toolName !== 'web_fetch' ||
    !message.settled ||
    message.executionUnconfirmed ||
    message.dispatchCommitted === false ||
    message.decisionRefresh ||
    message.toolStopping ||
    (message.approval && message.approval.state !== 'approved') ||
    (message.status !== 'completed' && message.status !== 'failed') ||
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 5
  )
    return;
  if (input.some((page) => !page || !Number.isSafeInteger(page.index))) return;
  const pages = [...input].sort((left, right) => left.index - right.index);
  if (
    pages.some(
      (page, index) =>
        page.index !== index || (page.outcome !== 'succeeded' && page.outcome !== 'failed'),
    )
  )
    return;
  const succeeded = pages.filter((page) => page.outcome === 'succeeded').length;
  const anyPageSucceeded = succeeded > 0;
  if ((message.status === 'completed') !== anyPageSucceeded) return;
  return {
    pages,
    succeeded,
    label: anyPageSucceeded ? `读取 ${succeeded}/${pages.length} 页` : '读取网页失败',
  };
}

/** Known categories and a validated HTTP status are the only displayable failure details. */
export function webFetchPageLabel(page: WebFetchBatchPage): string {
  if (page.outcome === 'succeeded') return '读取成功';
  switch (page.reason) {
    case 'invalid_url':
      return '网址无效';
    case 'denied':
      return '不允许读取此页';
    case 'timeout':
      return '读取超时';
    case 'http': {
      const status = page.httpStatus;
      return typeof status === 'number' &&
        Number.isSafeInteger(status) &&
        status >= 100 &&
        status <= 599 &&
        (status < 200 || status >= 300)
        ? `读取失败（HTTP ${status}）`
        : '网页未返回可读取的内容';
    }
    default:
      return '未读到正文';
  }
}
