/** Minimal, dependency-free ZIP central-directory reader - test-only infrastructure used to
 *  verify that a generated .docx is a genuine ZIP/OpenXML container (real entry names) and
 *  that its `word/document.xml` entry actually contains the Cyrillic text we asked for.
 *  Uses only Node's built-in `zlib` (raw DEFLATE inflate) - no new dependency. */

import zlib from 'node:zlib';

interface ZipEntry { name: string; compressionMethod: number; compressedData: Buffer }

function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  const searchStart = Math.max(0, buffer.length - 22 - 65536);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file (End Of Central Directory not found)');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const CD_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== CD_SIG) throw new Error('Malformed ZIP central directory record');
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength);

    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_SIG) throw new Error('Malformed ZIP local file header');
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.push({ name, compressionMethod, compressedData });
    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }
  return entries;
}

export function listZipEntries(buffer: Buffer): string[] {
  return readCentralDirectory(buffer).map(e => e.name);
}

export function readZipEntryText(buffer: Buffer, name: string): string {
  const entry = readCentralDirectory(buffer).find(e => e.name === name);
  if (!entry) throw new Error(`Zip entry not found: ${name}`);
  if (entry.compressedData.length === 0) return '';
  const data = entry.compressionMethod === 0 ? entry.compressedData : zlib.inflateRawSync(entry.compressedData);
  return data.toString('utf8');
}
