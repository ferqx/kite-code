// Only derived display data leaves this worker. Original input bytes are never rewritten.
self.onmessage = async (event: MessageEvent<{ id: number; source: Blob }>) => {
  const { id, source } = event.data;
  let image: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | undefined;
  try {
    image = await createImageBitmap(source, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 512 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw Error('preview_context_unavailable');
    context.drawImage(image, 0, 0, width, height);
    image.close();
    image = undefined;
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    self.postMessage({ id, blob, width, height });
  } catch {
    self.postMessage({ id, error: 'image_preview_unavailable' });
  } finally {
    image?.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
};
