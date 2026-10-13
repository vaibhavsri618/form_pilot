// Generates small, valid dummy files of whatever type an <input type=file>
// accepts: PDF, images, Word, Excel, CSV/TXT/JSON/XML, SVG and ZIP.

const enc = new TextEncoder();

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME).map(([ext, mime]) => [mime, ext]));
EXT_BY_MIME['image/jpeg'] = 'jpg';

/** Extensions an accept="" attribute allows; empty means anything. */
export function acceptedExts(accept) {
  const out = [];
  for (const raw of (accept || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (raw.startsWith('.')) out.push(raw.slice(1));
    else if (raw === 'image/*') out.push('png', 'jpg', 'jpeg', 'webp', 'gif', 'svg');
    else if (raw === 'text/*') out.push('txt', 'csv');
    else if (raw.endsWith('/*')) out.push(`*${raw}`); // video/*, audio/*: nothing we can make
    else if (EXT_BY_MIME[raw]) out.push(EXT_BY_MIME[raw]);
  }
  return out;
}

export function fileMatchesAccept(name, type, accept) {
  const exts = acceptedExts(accept);
  if (!exts.length || exts.includes('*/*')) return true;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return exts.includes(ext) || (type && exts.includes(EXT_BY_MIME[type]));
}

// Preferred order when several types are allowed.
const PREFERENCE = ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'xlsx', 'csv', 'txt', 'webp', 'json', 'xml', 'svg', 'zip', 'gif', 'doc', 'xls', 'md', 'bmp'];

function chooseExt(accept) {
  const exts = acceptedExts(accept);
  if (!exts.length || exts.includes('*/*')) return 'pdf';
  return PREFERENCE.find((e) => exts.includes(e)) || null;
}

const ascii = (s) => s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
const xmlEsc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------------ PDF

function makePdf(lines) {
  const esc = (s) => ascii(s).replace(/[\\()]/g, (m) => `\\${m}`);
  const stream = ['BT', '/F1 20 Tf', '72 740 Td', `(${esc(lines[0])}) Tj`, '/F1 12 Tf',
    ...lines.slice(1).flatMap((l) => ['0 -24 Td', `(${esc(l)}) Tj`]), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}

// ------------------------------------------------------------------ ZIP (stored, no compression)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = typeof text === 'string' ? enc.encode(text) : text;
    const nb = enc.encode(name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(12, 0x21, true); // 1980-01-01
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nb.length, true);
    local.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nb.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return concat([...local, ...central, new Uint8Array(end.buffer)]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function makeDocx(lines) {
  const paras = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r></w:p>`).join('');
  return makeZip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`],
  ]);
}

function makeXlsx(lines) {
  const rows = lines.map((l, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${xmlEsc(l)}</t></is></c></row>`).join('');
  return makeZip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`],
  ]);
}

// ---------------------------------------------------------------- images

async function makeImage(lines, mime) {
  const canvas = new OffscreenCanvas(800, 500);
  const g = canvas.getContext('2d');
  g.fillStyle = '#eef3ff';
  g.fillRect(0, 0, 800, 500);
  g.strokeStyle = '#2563eb';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 792, 492);
  g.fillStyle = '#1c1f24';
  g.font = 'bold 34px sans-serif';
  g.fillText(lines[0], 40, 90);
  g.font = '22px sans-serif';
  lines.slice(1).forEach((l, i) => g.fillText(l.slice(0, 60), 40, 150 + i * 40));
  const blob = await canvas.convertToBlob({ type: mime });
  return new Uint8Array(await blob.arrayBuffer());
}

function makeSvg(lines) {
  const text = lines.map((l, i) => `<text x="40" y="${80 + i * 40}" font-family="sans-serif" font-size="${i ? 22 : 32}">${xmlEsc(l)}</text>`).join('');
  return enc.encode(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#eef3ff"/>${text}</svg>`);
}

// ---------------------------------------------------------------- public

export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const slug = (s) => ascii(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'attachment';

/**
 * A dummy file acceptable to an input with this accept="" attribute.
 * @returns {Promise<{name: string, type: string, b64: string}>}
 */
export async function makeDummyFile(accept, label, forceExt) {
  const ext = forceExt || chooseExt(accept);
  if (!ext) throw new Error(`can't generate a "${accept}" file; add one under Attachments`);
  const lines = ['DUMMY DOCUMENT - FOR TESTING ONLY', `Field: ${ascii(label).slice(0, 70)}`,
    `Generated by Form Pilot on ${new Date().toISOString().slice(0, 10)}`];
  let bytes;
  if (ext === 'pdf') bytes = makePdf(lines);
  else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) bytes = await makeImage(lines, MIME[ext]);
  else if (['gif', 'bmp'].includes(ext)) bytes = await makeImage(lines, 'image/png'); // browsers can't encode these; most checks go by name
  else if (ext === 'svg') bytes = makeSvg(lines);
  else if (ext === 'docx' || ext === 'doc') bytes = makeDocx(lines);
  else if (ext === 'xlsx' || ext === 'xls') bytes = makeXlsx(lines);
  else if (ext === 'csv') bytes = enc.encode(`field,value\n"${label.replace(/"/g, '""')}",dummy\n`);
  else if (ext === 'json') bytes = enc.encode(JSON.stringify({ dummy: true, field: label }, null, 2));
  else if (ext === 'xml') bytes = enc.encode(`<?xml version="1.0"?><dummy field="${xmlEsc(label)}"/>`);
  else if (ext === 'zip') bytes = makeZip([['dummy.txt', lines.join('\n')]]);
  else bytes = enc.encode(lines.join('\n'));
  return { name: `dummy-${slug(label)}.${ext}`, type: MIME[ext] || 'application/octet-stream', b64: toBase64(bytes) };
}
