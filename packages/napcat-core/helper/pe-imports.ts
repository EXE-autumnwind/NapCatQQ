/**
 * 极简 PE 导入表解析器。
 *
 * 用途：反检测模块的若干开关是在 wrapper.node 的 IAT（导入地址表）上做 hook 的。
 * QQ 换版本后如果不再导入某个 API，对应的 hook 就会静默失效——所以启动时把
 * wrapper.node 的导入表读出来，和 BYPASS_API_REQUIREMENTS 对照，能提前告警。
 *
 * 只读 PE 头、节表、导入目录，不加载、不执行目标文件；对 100MB+ 的 wrapper.node
 * 也只按需读取若干小段，不整文件进内存。
 */
import fs from 'node:fs';

export interface ByteReader {
  size: number;
  read: (offset: number, length: number) => Buffer;
}

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawPointer: number;
  rawSize: number;
}

export interface PeImports {
  /** IMAGE_FILE_HEADER.Machine：0x8664 = x64，0xAA64 = arm64 */
  machine: number;
  is64Bit: boolean;
  imageBase: bigint;
  sections: PeSection[];
  /** DLL 名（小写）→ 该 DLL 的导入函数名列表 */
  imports: Map<string, string[]>;
}

const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const MAX_IMPORT_DESCRIPTORS = 4096;
const MAX_THUNKS_PER_DLL = 8192;
const MAX_NAME_LENGTH = 512;

export function createBufferReader (buffer: Buffer): ByteReader {
  return {
    size: buffer.length,
    read: (offset, length) => {
      const start = Math.max(0, offset);
      return buffer.subarray(start, Math.min(buffer.length, start + length));
    },
  };
}

export function createFileReader (filePath: string): ByteReader & { close: () => void } {
  const fd = fs.openSync(filePath, 'r');
  const { size } = fs.fstatSync(fd);
  return {
    size,
    read: (offset, length) => {
      const start = Math.max(0, offset);
      const available = Math.max(0, Math.min(length, size - start));
      const buffer = Buffer.alloc(available);
      if (available > 0) fs.readSync(fd, buffer, 0, available, start);
      return buffer;
    },
    close: () => fs.closeSync(fd),
  };
}

function readAscii (reader: ByteReader, offset: number, maxLength: number = MAX_NAME_LENGTH): string {
  const raw = reader.read(offset, maxLength);
  const end = raw.indexOf(0);
  return raw.toString('latin1', 0, end === -1 ? raw.length : end);
}

function rvaToOffset (sections: PeSection[], rva: number): number {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return rva - section.virtualAddress + section.rawPointer;
    }
  }
  return -1;
}

/**
 * 解析 PE 的导入表。
 * @throws 目标不是 PE / 结构损坏时抛出 Error
 */
export function parsePeImports (reader: ByteReader): PeImports {
  if (reader.size < 0x40) throw new Error('PE: 文件过小');

  const dosHeader = reader.read(0, 0x40);
  if (dosHeader.toString('latin1', 0, 2) !== 'MZ') throw new Error('PE: 缺少 MZ 头');

  const peOffset = dosHeader.readUInt32LE(0x3c);
  const coffHeader = reader.read(peOffset, 24);
  if (coffHeader.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error('PE: 缺少 PE 签名');

  const machine = coffHeader.readUInt16LE(4);
  const sectionCount = coffHeader.readUInt16LE(6);
  const optionalHeaderSize = coffHeader.readUInt16LE(20);
  const optionalHeaderOffset = peOffset + 24;
  const magic = reader.read(optionalHeaderOffset, 2).readUInt16LE(0);

  if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) throw new Error(`PE: 未知的可选头 magic 0x${magic.toString(16)}`);
  const is64Bit = magic === PE32_PLUS_MAGIC;
  const imageBase = is64Bit
    ? reader.read(optionalHeaderOffset + 24, 8).readBigUInt64LE(0)
    : BigInt(reader.read(optionalHeaderOffset + 28, 4).readUInt32LE(0));

  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const sections: PeSection[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const header = reader.read(sectionTableOffset + index * 40, 40);
    if (header.length < 40) break;
    sections.push({
      name: header.toString('latin1', 0, 8).replace(/\0+$/, ''),
      virtualSize: header.readUInt32LE(8),
      virtualAddress: header.readUInt32LE(12),
      rawSize: header.readUInt32LE(16),
      rawPointer: header.readUInt32LE(20),
    });
  }

  // 数据目录：导入表是索引 1（PE32+ 偏移 112，PE32 偏移 96）
  const dataDirectoryOffset = optionalHeaderOffset + (is64Bit ? 112 : 96);
  const importRva = reader.read(dataDirectoryOffset + 8, 4).readUInt32LE(0);
  const imports = new Map<string, string[]>();
  if (importRva === 0) return { machine, is64Bit, imageBase, sections, imports };

  const importOffset = rvaToOffset(sections, importRva);
  if (importOffset < 0) throw new Error('PE: 导入目录 RVA 无法映射到文件偏移');

  const thunkSize = is64Bit ? 8 : 4;
  for (let index = 0; index < MAX_IMPORT_DESCRIPTORS; index++) {
    const descriptor = reader.read(importOffset + index * 20, 20);
    if (descriptor.length < 20) break;
    const originalFirstThunk = descriptor.readUInt32LE(0);
    const nameRva = descriptor.readUInt32LE(12);
    const firstThunk = descriptor.readUInt32LE(16);
    if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;

    const nameOffset = rvaToOffset(sections, nameRva);
    if (nameOffset < 0) continue;
    const dllName = readAscii(reader, nameOffset).toLowerCase();
    if (!dllName) continue;

    const thunkRva = originalFirstThunk || firstThunk;
    const thunkOffset = rvaToOffset(sections, thunkRva);
    const names = imports.get(dllName) ?? [];
    if (thunkOffset >= 0) {
      for (let thunkIndex = 0; thunkIndex < MAX_THUNKS_PER_DLL; thunkIndex++) {
        const raw = reader.read(thunkOffset + thunkIndex * thunkSize, thunkSize);
        if (raw.length < thunkSize) break;
        const value = is64Bit ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0));
        if (value === 0n) break;
        // 最高位为 1 表示按序号导入，没有函数名
        const isOrdinal = is64Bit ? (value & (1n << 63n)) !== 0n : (value & (1n << 31n)) !== 0n;
        if (isOrdinal) continue;
        const hintOffset = rvaToOffset(sections, Number(value));
        if (hintOffset < 0) continue;
        const functionName = readAscii(reader, hintOffset + 2);
        if (functionName) names.push(functionName);
      }
    }
    imports.set(dllName, names);
  }

  return { machine, is64Bit, imageBase, sections, imports };
}

/** 直接解析内存中的 PE 数据 */
export function parsePeImportsFromBuffer (buffer: Buffer): PeImports {
  return parsePeImports(createBufferReader(buffer));
}

/** 解析磁盘上的 PE 文件（按需读取，适合 100MB+ 的 wrapper.node） */
export function parsePeImportsFromFile (filePath: string): PeImports {
  const reader = createFileReader(filePath);
  try {
    return parsePeImports(reader);
  } finally {
    reader.close();
  }
}

/** 汇总导入表：小写 API 名 → 提供它的 DLL 列表 */
export function flattenImports (imports: PeImports): Map<string, string[]> {
  const flat = new Map<string, string[]>();
  for (const [dll, names] of imports.imports) {
    for (const name of names) {
      const key = name.toLowerCase();
      const list = flat.get(key) ?? [];
      list.push(dll);
      flat.set(key, list);
    }
  }
  return flat;
}
