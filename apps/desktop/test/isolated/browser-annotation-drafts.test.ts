import { expect, test } from 'bun:test';
import {
  browserDraftImagesMatch,
  browserDraftProofText,
  composeBrowserDraft,
  readBrowserAnnotations,
} from '../../src/browser-annotation-content';
import { BrowserAnnotationDrafts } from '../../src/browser-annotation-drafts';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { annotationFixture } from '../browser-annotation.fixture';

function fixture() {
  const requests: NativeRequest[] = [];
  let fail = false;
  const bridge = {
    async request(request: NativeRequest) {
      requests.push(request);
      if (fail) throw Error('fixture');
      return null;
    },
    watch: () => () => {},
  } as NativeBridge;
  const owner = new BrowserAnnotationDrafts(bridge, 1);
  return {
    owner,
    requests,
    fail() {
      fail = true;
    },
  };
}
async function ready(owner: BrowserAnnotationDrafts, key = 'A') {
  const end = Date.now() + 2000;
  while (owner.get(key).some((item) => item.status === 'preparing')) {
    if (Date.now() > end) throw Error('preparation_timeout');
    await Bun.sleep(5);
  }
}
test('immutable frame bytes prepare once; prompt/note edits only change small metadata and matching versions', async () => {
  const f = fixture(),
    { input } = annotationFixture();
  try {
    const id = f.owner.add('A', input);
    input.frame.data = 'changed';
    input.note = 'changed';
    await ready(f.owner);
    expect(f.owner.get('A')[0]?.status).toBe('ready');
    expect(f.owner.get('A')[0]?.note).toBe('检查这里的普通文字');
    const count = f.requests.length,
      imageId = f.owner.get('A')[0]!.imageId;
    expect(f.owner.edit('A', id, '编辑后的说明')).toBe(true);
    expect(f.owner.get('A')[0]?.imageId).toBe(imageId);
    expect(f.requests).toHaveLength(count);
    expect(JSON.stringify(f.owner.document('A'))).not.toContain('/9j/2Q==');
    const batch = f.owner.capture('A');
    f.owner.bind('one', batch);
    expect(() => f.owner.bind('two', batch)).toThrow('browser_notes_changed');
    expect(f.owner.edit('A', id, 'late')).toBe(false);
    expect(f.owner.remove('A', id)).toBe(false);
    f.owner.settle('one', 'unknown', 'B');
    expect(f.owner.pending('A')).toBe('sending');
    f.owner.settle('one', 'unknown', 'A');
    expect(f.owner.pending('A')).toBe('unknown');
    expect(() => f.owner.capture('A')).toThrow('browser_notes_not_ready');
    f.owner.settle('one', 'failed');
    expect(f.owner.get('A')).toHaveLength(1);
    f.owner.bind('three', f.owner.capture('A'));
    const next = annotationFixture().input;
    f.owner.add('A', next);
    await ready(f.owner);
    f.owner.settle('three', 'accepted');
    expect(f.owner.get('A')).toHaveLength(1);
    expect(f.owner.get('A')[0]?.id).not.toBe(id);
    expect(
      f.requests.filter((r) => r.method === 'input.images.release' && r.id === imageId),
    ).toHaveLength(1);
    expect(f.owner.get('B')).toHaveLength(0);
  } finally {
    f.owner.close();
  }
});
test('cold metadata restores missing pixels, never creates prepared identities; failure and budgets preserve notes', async () => {
  const f = fixture(),
    { saved, input } = annotationFixture();
  try {
    f.owner.restore('cold', [saved]);
    expect(f.owner.get('cold')[0]).toMatchObject({
      status: 'missing_image',
      imageId: '',
      frame: { data: '' },
    });
    expect(f.requests).toHaveLength(0);
    expect(() => f.owner.capture('cold')).toThrow();
    f.owner.edit('cold', saved.id, '冷恢复编辑');
    expect(f.requests).toHaveLength(0);
    f.owner.restoreBinding(
      'old',
      'cold',
      [{ id: saved.id, version: 1, imageHash: saved.imageHash }],
      'accepted',
    );
    expect(f.owner.get('cold')).toHaveLength(1); // newer edit survives old receipt
    f.fail();
    f.owner.add('A', input);
    await ready(f.owner);
    expect(f.owner.get('A')[0]?.status).toBe('error');
    expect(f.owner.get('A')[0]?.note).toBe(input.note);
    for (let i = 1; i < 4; i++) f.owner.add('A', input);
    expect(() => f.owner.add('A', input)).toThrow('browser_note_limit');
    expect(() =>
      f.owner.add('B', { ...input, frame: { ...input.frame, data: 'A'.repeat(128 * 1024 + 1) } }),
    ).toThrow();
  } finally {
    f.owner.close();
  }
});
test('shared send projection preserves raw editor prompt, exact note text, source and image order; rejects metadata blobs and forged pixels', () => {
  const { saved } = annotationFixture(),
    content = '用户自己的提示词\r\n',
    document = { content, browserAnnotations: [saved], annotationImageOffset: 1 };
  const projected = composeBrowserDraft(document);
  expect(projected).toContain('用户自己的提示词');
  expect(projected).toContain(saved.note);
  expect(projected).toContain(saved.source.url);
  expect(projected).toContain('"ordinal": 2');
  expect(document.content).toBe(content);
  expect(browserDraftProofText({ content })).toBe(content);
  expect(() =>
    readBrowserAnnotations([{ ...saved, frame: { ...saved.frame, data: '/9j/2Q==' } }]),
  ).toThrow();
  const image = {
    reference: {
      hash: saved.imageHash,
      size: String(saved.frame.byteLength),
      mediaType: 'image/jpeg',
    },
  };
  expect(browserDraftImagesMatch(document, [image, image])).toBe(true);
  expect(browserDraftImagesMatch(document, [image])).toBe(false);
  expect(
    browserDraftImagesMatch(document, [
      image,
      { reference: { ...image.reference, hash: 'f'.repeat(64) } },
    ]),
  ).toBe(false);
});
