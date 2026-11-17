import { expect, test } from 'bun:test';
import { imageGalleryNeedsDetail, imageGalleryRegion } from '../src/desktop/ImageGalleryDetail';

test('visible stage clips to oriented source pixels with conservative integer boundaries', () => {
  expect(
    imageGalleryRegion(
      { left: 100, top: -12245, width: 8000, height: 40000 },
      { left: 100, top: 100, width: 900, height: 600 },
      8000,
      40000,
    ),
  ).toEqual({ left: 0, top: 12345, width: 900, height: 600 });
  expect(
    imageGalleryRegion(
      { left: 200, top: 200, width: 500, height: 1000 },
      { left: 100, top: 100, width: 900, height: 600 },
      1000,
      2000,
    ),
  ).toEqual({ left: 0, top: 0, width: 1000, height: 1000 });
  expect(
    imageGalleryRegion(
      { left: 100, top: 100, width: 2000, height: 1000 },
      { left: 110, top: 120, width: 150, height: 200 },
      40000,
      20000,
    ),
  ).toEqual({ left: 200, top: 400, width: 3000, height: 4000 });
  expect(
    imageGalleryRegion(
      { left: 0, top: 0, width: 0, height: 0 },
      { left: 100, top: 100, width: 900, height: 600 },
      8000,
      40000,
    ),
  ).toBeNull();
});

test('full-source overview never requests redundant ROI at high zoom or DPR', () => {
  expect(imageGalleryNeedsDetail(1600, 1000, 2048, 6400)).toBe(false);
  expect(imageGalleryNeedsDetail(4000, 3000, 4096, 16000)).toBe(false);
  expect(imageGalleryNeedsDetail(1000, 40000, 4096, 40000)).toBe(true);
  expect(imageGalleryNeedsDetail(8000, 8000, 4096, 3000)).toBe(false);
});
