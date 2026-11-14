import { expect, test } from 'bun:test';
import { LocalPreviewSubmissions, localPdfRequestContent } from '../electron/local-preview-submit';

test('local annotation ownership never dispatches twice after lost or rejected result', async () => {
  const submissions = new LocalPreviewSubmissions<string>();
  let calls = 0;
  const perform = async () => {
    calls++;
    throw Error('reply_lost');
  };
  const first = submissions.run('scope/request', 'command', perform);
  const duplicate = submissions.run('scope/request', 'command', perform);
  expect(duplicate).toBe(first);
  await expect(first).rejects.toThrow('reply_lost');
  await expect(submissions.run('scope/request', 'command', perform)).rejects.toThrow('reply_lost');
  expect(() => submissions.run('scope/request', 'another-command', perform)).toThrow(
    'local_preview_request_submitted',
  );
  expect(calls).toBe(1);
});
test('local annotation scopes are independent and bounded', async () => {
  const submissions = new LocalPreviewSubmissions<string>();
  for (let i = 0; i < 128; i++) await submissions.run(String(i), 'command', async () => 'accepted');
  expect(() => submissions.run('new', 'command', async () => 'accepted')).toThrow(
    'local_preview_request_limit',
  );
  submissions.clear();
  expect(await submissions.run('new', 'command', async () => 'accepted')).toBe('accepted');
});
test('local PDF content represents original reference and untrusted selection, not output authority', () => {
  const content = localPdfRequestContent(
    '调整这里',
    { path: '/tmp/a\n"b.pdf', name: 'a.pdf', sourceHash: 'a'.repeat(64) },
    {
      sourceHash: 'a'.repeat(64),
      selection: {
        kind: 'pdf',
        page: 2,
        pageBasis: 'pdf-rendered',
        scope: 'region',
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
      },
    },
  );
  expect(content).toContain('文件未上传');
  expect(content).toContain('不可信文档数据');
  expect(content).toContain('不覆盖原件');
  expect(content).toContain('a\\n\\"b.pdf');
  expect(content).not.toContain('fileId');
});
