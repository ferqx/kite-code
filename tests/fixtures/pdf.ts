/** Minimal genuine, deterministic PDF; tests exercise the real parser and canvas. */
export function simplePdf() {
  const body = 'BT /F1 16 Tf 40 700 Td (Hello PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ];
  return pdfObjects(objects);
}

/** Fixed column-major article and row-major table, with an independently visible grid. */
export function columnsAndTablePdf() {
  const line = (x: number, y: number, text: string) =>
    `BT /F1 14 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`;
  const body = [
    line(40, 750, 'Two columns and a table'),
    line(40, 700, 'LEFT 1: apples'),
    line(40, 675, 'LEFT 2: pears'),
    line(40, 650, 'LEFT 3: total 10'),
    line(330, 700, 'RIGHT 1: oranges'),
    line(330, 675, 'RIGHT 2: lemons'),
    line(330, 650, 'RIGHT 3: total 12'),
    '0.8 0.9 1 rg 40 520 520 40 re f 0 g 1 w',
    '40 440 520 120 re S 40 480 m 560 480 l S 40 520 m 560 520 l S',
    '300 440 m 300 560 l S',
    line(52, 536, 'Fruit'),
    line(312, 536, 'Count'),
    line(52, 496, 'Apples'),
    line(312, 496, '7'),
    line(52, 456, 'Pears'),
    line(312, 456, '3'),
  ].join('\n');
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ]);
}

function pdfObjects(objects: string[]) {
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}

/** Real CMap, two physical pages, labels, rotation and a non-text page. */
export function chinesePagedPdf() {
  const text = 'BT /F1 16 Tf 40 700 Td <4E2D6587> Tj ET';
  const drawing = '0 0 1 rg 20 20 100 100 re f';
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /r >>] >> >>',
    '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4000 2000] /Rotate 90 /Resources << >> /Contents 8 0 R >>',
    `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`,
  ]);
}

/** Valid PDF structure with a deliberately invalid embedded TrueType font program. */
export function brokenEmbeddedFontPdf() {
  const text = 'BT /F1 16 Tf 40 700 Td (A) Tj ET';
  const font = 'not-a-TrueType-font';
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /TrueType /BaseFont /BrokenFixture /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 65 /Widths [600] /FontDescriptor 6 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /FontDescriptor /FontName /BrokenFixture /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>',
    `<< /Length ${font.length} /Length1 ${font.length} >>\nstream\n${font}\nendstream`,
  ]);
}

/** Two maximum-sized pages share one deterministic, poorly compressible RGB image. */
export function noisyPagedPdf() {
  const width = 2048;
  const pixels = Buffer.alloc(width * width * 3);
  let state = 1729;
  for (let index = 0; index < pixels.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 255;
  }
  const drawing = `q ${width} 0 0 ${width} 0 0 cm /Noise Do Q`;
  const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${width}] /Resources << /XObject << /Noise 4 0 R >> >> /Contents 5 0 R >>`;
  return binaryPdfObjects([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'),
    Buffer.from(page),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${width} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
      ),
      pixels,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`),
    Buffer.from(page),
  ]);
}

/** Raster-only PDF: the visible text/chart cannot be recovered from PDF text operators. */
export function rasterPdf(jpeg: Uint8Array, width: number, height: number) {
  const drawing = `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q`;
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>`,
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`),
  ];
  return binaryPdfObjects(objects);
}

function binaryPdfObjects(objects: Uint8Array[]) {
  const parts: Uint8Array[] = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n'));
  }
  const xref = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
        .join(
          '',
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
    ),
  );
  return Buffer.concat(parts);
}
