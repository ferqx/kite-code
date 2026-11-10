import { parseDecimal64 } from '@kite-ai/trajectory';
import { useEffect, useState } from 'react';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function savedSize(value: unknown): string | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  if (typeof value !== 'string') return;
  try {
    parseDecimal64(value);
    return value;
  } catch {
    return;
  }
}

/** Public descriptions only. Names and metadata never authorize a URI, path or image read. */
export function TrajectoryAttachments({ data }: { data: unknown }) {
  const body = object(data);
  if (!body) return null;
  const entries: unknown[] = [];
  let malformed = false;
  const append = (value: unknown) => {
    if (value === undefined) return;
    if (Array.isArray(value)) for (const entry of value) entries.push(entry);
    else malformed = true;
  };
  if (Object.hasOwn(body, 'attachments')) append(body.attachments);
  else {
    append(body.images);
    append(body.files);
  }
  if (!entries.length && !malformed) return null;
  return (
    <section className="trajectory-attachments" aria-label="已保存附件">
      <h4>附件</h4>
      {malformed && <p role="status">已保存的附件描述格式无法识别。</p>}
      {entries.length > 0 && (
        <ul>
          {entries.map((entry, index) => {
            const item = object(entry);
            if (!item || typeof item.name !== 'string')
              return (
                <li key={index}>
                  <p role="status">附件 {index + 1} 的已保存描述无法识别。</p>
                </li>
              );
            const size = savedSize(item.size);
            const metadata = [
              typeof item.mediaType === 'string' ? item.mediaType : undefined,
              size !== undefined
                ? `${size} 字节`
                : item.size !== undefined
                  ? '大小格式无法识别'
                  : undefined,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={index} className="trajectory-attachment-description">
                <span className="trajectory-attachment-name" title={item.name}>
                  {item.name || '未命名附件'}
                </span>
                {metadata && <span className="trajectory-attachment-metadata">{metadata}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
interface SavedImage {
  mediaType: string;
  data: string;
}
function savedImage(value: unknown): SavedImage | undefined {
  const item = object(value);
  if (
    !item ||
    Object.keys(item).sort().join(',') !== 'data,mediaType' ||
    typeof item.mediaType !== 'string' ||
    !mediaTypes.has(item.mediaType) ||
    typeof item.data !== 'string'
  )
    return;
  const data = item.data;
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  // Reject non-canonical padding bits without decoding or copying the entire saved image.
  if (data.endsWith('==') && alphabet.indexOf(data.at(-3)!) % 16 !== 0) return;
  if (!data.endsWith('==') && data.endsWith('=') && alphabet.indexOf(data.at(-2)!) % 4 !== 0)
    return;
  return item as unknown as SavedImage;
}
function SavedImagePreview({ image, index }: { image: SavedImage; index: number }) {
  const [failed, setFailed] = useState<SavedImage | null>(null);
  useEffect(() => {
    setFailed((current) => (current === image ? current : null));
  }, [image]);
  return (
    <figure>
      {failed === image ? (
        <p role="status">图片 {index + 1} 未展示：已保存字节无法解码为该格式的图片。</p>
      ) : (
        <img
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={`已保存的请求图片 ${index + 1}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(image)}
        />
      )}
      <figcaption>
        图片 {index + 1} · {image.mediaType}
      </figcaption>
    </figure>
  );
}

/** Exact authorized ModelMessage.images bytes only; never URLs, paths or attachment descriptions. */
export function TrajectoryMessageImages({ images }: { images: unknown }) {
  if (images === undefined) return null;
  if (!Array.isArray(images)) return <p role="status">已保存的请求图片列表格式无法识别。</p>;
  if (!images.length) return null;
  return (
    <section className="trajectory-message-images" aria-label="已保存请求图片">
      {images.map((value, index) => {
        const image = savedImage(value);
        return image ? (
          <SavedImagePreview key={index} image={image} index={index} />
        ) : (
          <p key={index} role="status">
            图片 {index + 1} 未展示：已保存图片的格式或编码无法识别。
          </p>
        );
      })}
    </section>
  );
}
