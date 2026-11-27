import { Button, Spinner } from '@kite-ai/ui/desktop';

type PreviewFailure = { message: string; retry?: boolean; sourceUnavailable?: true };
export type FilePreviewState = 'loading' | 'ready' | PreviewFailure;

export function filePreviewFailure(error?: unknown): PreviewFailure {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : error instanceof Error
        ? error.message
        : undefined;
  if (typeof code === 'string' && code.startsWith('local_preview_'))
    return { message: '文件或访问权限已变化，请关闭后重新打开' };
  switch (code) {
    case 'output_file_not_found':
    case 'output_source_unavailable':
    case 'output_scope_unavailable':
    case 'output_source_observation_changed':
      return { message: '无法读取文件信息', retry: true, sourceUnavailable: true };
    case 'preview_format_unavailable':
      return { message: '二进制文件无法打开' };
    case 'preview_text_budget':
      return { message: '文本过大，无法预览' };
    case 'preview_text_encoding_unavailable':
      return { message: '暂不支持此文本编码' };
    case 'preview_image_budget':
    case 'preview_office_archive_budget':
    case 'preview_office_source_budget':
      return { message: '文件超出预览大小限制' };
    case 'preview_office_archive_invalid':
      return { message: '无法读取文件结构' };
    case 'pdf_font_invalid':
      return { message: 'PDF 字体无法读取，请使用嵌入可用字体的版本' };
    default:
      return { message: '预览失败', retry: true };
  }
}

export function NativeFilePreviewStatus({
  state,
  onRetry,
  onEditWholeFile,
}: {
  state: FilePreviewState;
  onRetry(): void;
  onEditWholeFile?(): void;
}) {
  if (state === 'ready') return null;
  return (
    <div className="native-file-preview-state">
      {state === 'loading' ? (
        <Spinner aria-label="文件预览加载中" size={20} />
      ) : (
        <div className="native-file-preview-error">
          <p role="status">{state.message}</p>
          {state.retry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              重试
            </Button>
          )}
          {onEditWholeFile && (
            <Button variant="secondary" size="sm" onClick={onEditWholeFile}>
              继续修改整个文件
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
