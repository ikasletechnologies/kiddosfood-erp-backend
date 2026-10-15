/**
 * Minimal, dependency-free .docx text reader for the recipe import.
 *
 * A .docx is a ZIP archive; the body text lives in word/document.xml. This
 * reads the ZIP central directory, inflates that one entry with Node's zlib
 * (size-capped against zip bombs) and returns the document's paragraphs in
 * order, with whether each is a numbered/bulleted list item — the import
 * parser uses that to find recipe titles.
 */
import { inflateRawSync } from 'zlib';

export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
const MAX_XML_BYTES = 30 * 1024 * 1024;

export interface DocxParagraph {
  text: string;
  /** Word list item (numbered or bulleted), e.g. "• Idli/ Dosa Batter". */
  listItem: boolean;
  style: string | null;
  inTable: boolean;
}

export class DocxError extends Error {
  status = 400;
}

function readZipEntry(buf: Buffer, wanted: string): Buffer {
  // End of central directory: last occurrence of 0x06054b50 (comment ≤ 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocxError('This file is not a valid Word (.docx) document.');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new DocxError('The Word document is damaged (bad ZIP directory).');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;

    if (size > MAX_XML_BYTES) throw new DocxError('The Word document is too large to import.');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new DocxError('The Word document is damaged (bad ZIP entry).');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) return Buffer.from(data);
    if (method === 8) {
      try {
        return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      } catch {
        throw new DocxError('The Word document could not be read (decompression failed).');
      }
    }
    throw new DocxError(`The Word document uses an unsupported compression method (${method}).`);
  }
  throw new DocxError('This file has no Word document body (word/document.xml). Upload a .docx file.');
}

const decodeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** Text of one <w:p>: runs joined, tabs kept, line breaks become "\n". */
function paragraphText(xml: string): string {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else out += m[0] === '<w:tab/>' ? '\t' : '\n';
  }
  return out;
}

/** Paragraphs of a .docx in document order (table cells included). */
export function readDocxParagraphs(file: Buffer): DocxParagraph[] {
  if (!Buffer.isBuffer(file) || file.length < 22) throw new DocxError('The uploaded file is empty.');
  if (file.length > MAX_DOCX_BYTES) throw new DocxError('The Word document is larger than 10 MB.');
  if (file.readUInt32LE(0) !== 0x04034b50) throw new DocxError('This file is not a Word (.docx) document. Old .doc files must be saved as .docx first.');
  const xml = readZipEntry(file, 'word/document.xml').toString('utf8');
  const body = xml.split(/<w:body>/)[1] ?? xml;

  const paragraphs: DocxParagraph[] = [];
  const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  const paraRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const push = (p: string, inTable: boolean) => {
    const text = paragraphText(p);
    text.split('\n').forEach((line, i) => {
      paragraphs.push({
        text: line,
        // Only a paragraph's first line carries its bullet.
        listItem: i === 0 && /<w:numPr>/.test(p),
        style: (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || null,
        inTable,
      });
    });
  };
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body))) {
    if (m[0].startsWith('<w:tbl')) {
      for (const p of m[0].match(paraRe) || []) push(p, true);
    } else if (m[0] !== '<w:p/>') {
      push(m[0], false);
    }
  }
  return paragraphs;
}
