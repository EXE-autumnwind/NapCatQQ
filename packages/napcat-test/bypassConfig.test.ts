import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BYPASS_KEYS,
  DEFAULT_BYPASS_OPTIONS,
  SUPPORTED_BYPASS_PLATFORMS,
  applyBypass,
  findUnknownBypassKeys,
  formatBypassOptions,
  getBypassStatus,
  isAnyBypassEnabled,
  normalizeBypassOptions,
  resetBypassStatus,
} from '@/napcat-core/helper/bypass';
import { loadNapcatConfig, normalizeNapcatConfig } from '@/napcat-core/helper/config';
import {
  BYPASS_STATIC_REQUIREMENTS,
  findQQNTDll,
  initBypass,
  probeBypassCompat,
  resetBypassProbe,
} from '@/napcat-core/helper/bypass-probe';
import { flattenImports, parsePeImportsFromBuffer } from '@/napcat-core/helper/pe-imports';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tempDirs: string[] = [];

function makeTempDir (): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-bypass-'));
  tempDirs.push(dir);
  return dir;
}

const silentLogger = { log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  resetBypassStatus();
  resetBypassProbe();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 造一个最小可用 PE（一个 .rdata 节 + 导入表），用于离线验证解析器与自检逻辑。
 * 只实现解析器真正读取的字段，足够覆盖 x64/x86 两种 thunk 宽度。
 */
function buildPeWithImports (dllImports: Record<string, string[]>, is64Bit = true): Buffer {
  const sectionRva = 0x1000;
  const sectionRaw = 0x200;
  const optionalHeaderSize = is64Bit ? 0xf0 : 0xe0;
  const peOffset = 0x40;
  const optionalOffset = peOffset + 24;
  const sectionTableOffset = optionalOffset + optionalHeaderSize;
  const thunkSize = is64Bit ? 8 : 4;
  const buffer = Buffer.alloc(sectionRaw + 0x4000);

  // ---- 规划 .rdata 内部布局 ----
  const dlls = Object.entries(dllImports);
  const descriptorBytes = (dlls.length + 1) * 20;
  let cursor = descriptorBytes;
  const thunkOffsets: number[] = [];
  for (const [, names] of dlls) {
    thunkOffsets.push(cursor);
    cursor += (names.length + 1) * thunkSize;
  }
  const nameLayout: { dllNameOffset: number; funcOffsets: number[]; }[] = [];
  for (const [dll, names] of dlls) {
    if (cursor % 2 !== 0) cursor += 1;
    const dllNameOffset = cursor;
    cursor += Buffer.byteLength(dll) + 1;
    const funcOffsets: number[] = [];
    for (const name of names) {
      if (cursor % 2 !== 0) cursor += 1;
      funcOffsets.push(cursor);
      cursor += 2 + Buffer.byteLength(name) + 1;
    }
    nameLayout.push({ dllNameOffset, funcOffsets });
  }
  const sectionSize = cursor;

  // ---- PE 头 ----
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\0\0', peOffset, 'latin1');
  buffer.writeUInt16LE(is64Bit ? 0x8664 : 0x14c, peOffset + 4);
  buffer.writeUInt16LE(1, peOffset + 6);
  buffer.writeUInt16LE(optionalHeaderSize, peOffset + 20);

  buffer.writeUInt16LE(is64Bit ? 0x20b : 0x10b, optionalOffset);
  if (is64Bit) buffer.writeBigUInt64LE(0x180000000n, optionalOffset + 24);
  else buffer.writeUInt32LE(0x10000000, optionalOffset + 28);
  const dataDirectoryOffset = optionalOffset + (is64Bit ? 112 : 96);
  buffer.writeUInt32LE(sectionRva, dataDirectoryOffset + 8);
  buffer.writeUInt32LE(descriptorBytes, dataDirectoryOffset + 12);

  buffer.write('.rdata', sectionTableOffset, 'latin1');
  buffer.writeUInt32LE(sectionSize, sectionTableOffset + 8);
  buffer.writeUInt32LE(sectionRva, sectionTableOffset + 12);
  buffer.writeUInt32LE(sectionSize, sectionTableOffset + 16);
  buffer.writeUInt32LE(sectionRaw, sectionTableOffset + 20);

  // ---- .rdata 内容 ----
  const at = (offset: number) => sectionRaw + offset;
  dlls.forEach(([dll, names], index) => {
    const descriptorOffset = at(index * 20);
    buffer.writeUInt32LE(sectionRva + thunkOffsets[index]!, descriptorOffset);
    buffer.writeUInt32LE(sectionRva + nameLayout[index]!.dllNameOffset, descriptorOffset + 12);
    buffer.writeUInt32LE(sectionRva + thunkOffsets[index]!, descriptorOffset + 16);
    names.forEach((_name, nameIndex) => {
      const value = sectionRva + nameLayout[index]!.funcOffsets[nameIndex]!;
      const thunkOffset = at(thunkOffsets[index]! + nameIndex * thunkSize);
      if (is64Bit) buffer.writeBigUInt64LE(BigInt(value), thunkOffset);
      else buffer.writeUInt32LE(value, thunkOffset);
    });
    buffer.write(dll, at(nameLayout[index]!.dllNameOffset), 'latin1');
    names.forEach((name, nameIndex) => {
      const hintOffset = at(nameLayout[index]!.funcOffsets[nameIndex]!);
      buffer.writeUInt16LE(0, hintOffset);
      buffer.write(name, hintOffset + 2, 'latin1');
    });
  });

  return buffer;
}

const KERNEL32_EXPORTS = [
  'VirtualQuery',
  'K32EnumProcessModules',
  'GetModuleHandleW',
  'GetModuleHandleExA',
  'GetModuleFileNameW',
  'GetModuleFileNameA',
];

describe('反检测开关归一化', () => {
  it('缺省与非法输入回落到全关默认值', () => {
    expect(normalizeBypassOptions(undefined)).toEqual(DEFAULT_BYPASS_OPTIONS);
    expect(normalizeBypassOptions(null)).toEqual(DEFAULT_BYPASS_OPTIONS);
    expect(normalizeBypassOptions('nope')).toEqual(DEFAULT_BYPASS_OPTIONS);
    expect(normalizeBypassOptions([true])).toEqual(DEFAULT_BYPASS_OPTIONS);
  });

  it('保留布尔值、丢弃未知键、兼容手改配置里的字符串布尔', () => {
    const normalized = normalizeBypassOptions({
      hook: true,
      window: 'true',
      module: 'false',
      process: 1,
      container: false,
      js: false,
      typo_key: true,
    });
    expect(normalized).toEqual({ ...DEFAULT_BYPASS_OPTIONS, hook: true, window: true, container: false });
    expect(findUnknownBypassKeys({ hook: true, o3HookMode: 1 })).toEqual(['o3HookMode']);
  });

  it('日志格式化与"是否开启任一开关"判断保持同步', () => {
    expect(formatBypassOptions(DEFAULT_BYPASS_OPTIONS)).toBe(BYPASS_KEYS.map(key => `${key}=false`).join(','));
    expect(isAnyBypassEnabled(DEFAULT_BYPASS_OPTIONS)).toBe(false);
    expect(isAnyBypassEnabled({ ...DEFAULT_BYPASS_OPTIONS, js: true })).toBe(true);
  });
});

describe('napcat 配置解析', () => {
  it('没有配置文件时给出完整默认值（bypass 六项全 false）', () => {
    const config = loadNapcatConfig(makeTempDir());
    expect(config.bypass).toEqual(DEFAULT_BYPASS_OPTIONS);
    expect(config.packetBackend).toBe('auto');
  });

  it('部分 bypass 与未知键不会把整份配置带偏', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'napcat.json'), JSON.stringify({
      bypass: { hook: true, unknown_switch: true },
      fileLog: 'not-a-boolean',
      o3HookMode: 1,
    }), 'utf-8');
    const config = loadNapcatConfig(dir);
    expect(config.bypass).toEqual({ ...DEFAULT_BYPASS_OPTIONS, hook: true });
    expect(config.o3HookMode).toBe(1);
    // 类型错误的字段回落到默认值，而不是让启动失败
    expect(config.fileLog).toBe(false);
  });

  it('配置内容不是 JSON5 对象时使用默认值', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'napcat.json'), '{ broken', 'utf-8');
    expect(loadNapcatConfig(dir).bypass).toEqual(DEFAULT_BYPASS_OPTIONS);
  });

  it('normalizeNapcatConfig 保证 bypass 字段一定存在', () => {
    expect(normalizeNapcatConfig({}).bypass).toEqual(DEFAULT_BYPASS_OPTIONS);
  });
});

describe('applyBypass', () => {
  it('原生模块未加载时不抛异常并记录原因', () => {
    const status = applyBypass({ loaded: false, nativeExports: {} }, { hook: true }, silentLogger);
    expect(status.applied).toBe(false);
    expect(status.moduleLoaded).toBe(false);
    expect(status.error).toBe('napi2native 未加载');
    expect(getBypassStatus()).toEqual(status);
    expect(silentLogger.logWarn).toHaveBeenCalled();
  });

  it('环境变量禁用时不调用原生模块', () => {
    const enable = vi.fn().mockReturnValue(true);
    const status = applyBypass({ loaded: true, nativeExports: { enableAllBypasses: enable } }, { hook: true }, silentLogger, { NAPCAT_DISABLE_BYPASS: '1' });
    expect(status.disabledByEnv).toBe(true);
    expect(status.applied).toBe(false);
    expect(enable).not.toHaveBeenCalled();
  });

  it('原生模块确认接管后 effective 与 requested 一致', () => {
    const enable = vi.fn().mockReturnValue(true);
    const status = applyBypass({ loaded: true, nativeExports: { enableAllBypasses: enable } }, { js: true }, silentLogger, {});
    expect(status.applied).toBe(true);
    expect(status.effective).toEqual({ ...DEFAULT_BYPASS_OPTIONS, js: true });
    expect(enable).toHaveBeenCalledWith({ ...DEFAULT_BYPASS_OPTIONS, js: true });
  });

  it('返回 false 与抛异常都只降级、不影响启动', () => {
    const rejected = applyBypass({ loaded: true, nativeExports: { enableAllBypasses: () => false } }, { hook: true }, silentLogger, {});
    expect(rejected.applied).toBe(false);
    expect(rejected.error).toBe('enableAllBypasses 返回 false');

    const thrown = applyBypass({
      loaded: true,
      nativeExports: {
        enableAllBypasses: () => {
          throw new Error('boom');
        },
      },
    }, { hook: true }, silentLogger, {});
    expect(thrown.applied).toBe(false);
    expect(thrown.error).toBe('boom');
  });

  it('原生模块缺少导出时给出明确原因', () => {
    const status = applyBypass({ loaded: true, nativeExports: {} }, { hook: true }, silentLogger, {});
    expect(status.error).toBe('napi2native 未导出 enableAllBypasses');
  });
});

describe('PE 导入表解析', () => {
  it('解析 x64 导入表', () => {
    const pe = parsePeImportsFromBuffer(buildPeWithImports({ 'KERNEL32.dll': KERNEL32_EXPORTS, 'ws2_32.dll': ['send', 'recv'] }));
    expect(pe.is64Bit).toBe(true);
    expect(pe.machine).toBe(0x8664);
    expect(pe.imports.get('kernel32.dll')).toEqual(KERNEL32_EXPORTS);
    expect(pe.imports.get('ws2_32.dll')).toEqual(['send', 'recv']);
    expect(flattenImports(pe).get('virtualquery')).toEqual(['kernel32.dll']);
  });

  it('解析 x86 导入表', () => {
    const pe = parsePeImportsFromBuffer(buildPeWithImports({ 'KERNEL32.dll': KERNEL32_EXPORTS }, false));
    expect(pe.is64Bit).toBe(false);
    expect(pe.machine).toBe(0x14c);
    expect(pe.imports.get('kernel32.dll')).toEqual(KERNEL32_EXPORTS);
  });

  it('非 PE 数据直接报错而不是静默返回空表', () => {
    expect(() => parsePeImportsFromBuffer(Buffer.from('not a pe file at all'))).toThrow(/PE/);
  });
});

describe('反检测静态自检', () => {
  it('导入齐全时 hook/module/process 判定为 present', () => {
    const dir = makeTempDir();
    const wrapperPath = path.join(dir, 'wrapper.node');
    fs.writeFileSync(wrapperPath, buildPeWithImports({ 'KERNEL32.dll': KERNEL32_EXPORTS }));
    const report = probeBypassCompat({ wrapperPath, platform: 'win32.x64' });
    expect(report.wrapperImports?.apis).toBe(KERNEL32_EXPORTS.length);
    expect(report.switches.hook?.state).toBe('present');
    expect(report.switches.module?.state).toBe('present');
    expect(report.switches.process?.state).toBe('present');
    // 没有 QQNT.dll，窗口与 JS 的字符串特征无法核对
    expect(report.switches.window?.state).toBe('missing');
    expect(report.switches.js?.missing[0]).toContain('QQNT.dll');
    expect(report.switches.container?.state).toBe('unknown');
  });

  it('QQ 不再导入某个 API 时降级为 partial 并指出缺失项', () => {
    const dir = makeTempDir();
    const wrapperPath = path.join(dir, 'wrapper.node');
    fs.writeFileSync(wrapperPath, buildPeWithImports({ 'KERNEL32.dll': ['VirtualQuery', 'GetModuleHandleW'] }));
    const report = probeBypassCompat({ wrapperPath, platform: 'win32.x64' });
    expect(report.switches.hook?.state).toBe('present');
    expect(report.switches.module?.state).toBe('partial');
    expect(report.switches.module?.missing).toEqual(
      expect.arrayContaining(['wrapper.node!K32EnumProcessModules', 'wrapper.node!GetModuleHandleExA'])
    );
  });

  it('wrapper.node 不存在时把原因写进报告而不是抛异常', () => {
    const report = probeBypassCompat({ wrapperPath: path.join(makeTempDir(), 'missing.node'), platform: 'win32.x64' });
    expect(report.error).toBe('wrapper.node 未找到');
    expect(report.switches.hook?.state).toBe('missing');
    expect(report.switches.hook?.missing[0]).toContain('导入表不可读');
  });

  it('findQQNTDll 从 wrapper.node 所在目录向上查找', () => {
    const dir = makeTempDir();
    const appDir = path.join(dir, 'versions', '9.9.37-54395', 'resources', 'app');
    fs.mkdirSync(appDir, { recursive: true });
    const qqnt = path.join(dir, 'versions', '9.9.37-54395', 'QQNT.dll');
    fs.writeFileSync(qqnt, 'stub');
    const wrapperPath = path.join(appDir, 'wrapper.node');
    expect(findQQNTDll(wrapperPath)).toBe(qqnt);
    expect(findQQNTDll(undefined)).toBeUndefined();
  });
});

describe('initBypass 启动入口', () => {
  it('没有开关开启时不扫描 QQ 运行时文件', () => {
    const result = initBypass({ loaded: true, nativeExports: { enableAllBypasses: () => true } }, DEFAULT_BYPASS_OPTIONS, silentLogger, {});
    expect(result.status.applied).toBe(true);
    expect(result.probe).toBeNull();
  });

  it('有开关开启时执行自检并把缺失项写进日志', () => {
    const dir = makeTempDir();
    const wrapperPath = path.join(dir, 'wrapper.node');
    fs.writeFileSync(wrapperPath, buildPeWithImports({ 'KERNEL32.dll': ['VirtualQuery'] }));
    const result = initBypass(
      { loaded: true, nativeExports: { enableAllBypasses: () => true } },
      { ...DEFAULT_BYPASS_OPTIONS, window: true },
      silentLogger,
      { wrapperPath, platform: 'win32.x64' }
    );
    expect(result.probe).not.toBeNull();
    expect(result.probe!.switches.window?.state).toBe('missing');
    expect(silentLogger.logWarn).toHaveBeenCalledWith(expect.stringContaining('window'));
  });
});

describe('反检测配置与产物一致性守卫', () => {
  it('随包 napcat.json 的 bypass 键与代码一致且都是布尔', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/napcat-core/external/napcat.json'), 'utf-8'));
    expect(Object.keys(shipped.bypass).sort()).toEqual([...BYPASS_KEYS].sort());
    for (const key of BYPASS_KEYS) expect(typeof shipped.bypass[key]).toBe('boolean');
    expect(shipped.bypass).toEqual(DEFAULT_BYPASS_OPTIONS);
  });

  it('WebUI 的 BypassOptions 声明与核心 schema 键一致', () => {
    const dts = fs.readFileSync(
      path.join(repoRoot, 'packages/napcat-webui-frontend/src/types/napcat_conf.d.ts'),
      'utf-8'
    );
    const body = dts.slice(dts.indexOf('interface BypassOptions'), dts.indexOf('interface NapCatConfig'));
    const declared = [...body.matchAll(/^\s{2}(\w+): boolean;/gm)].map(match => match[1]);
    expect(declared.sort()).toEqual([...BYPASS_KEYS].sort());
  });

  it('每个声明支持的平台都有对应的 napi2native 产物', () => {
    const nativeDir = path.join(repoRoot, 'packages/napcat-native/napi2native');
    for (const platform of SUPPORTED_BYPASS_PLATFORMS) {
      const binary = path.join(nativeDir, `napi2native.${platform}.node`);
      expect(fs.existsSync(binary), `缺少 ${platform} 的 napi2native 产物`).toBe(true);
      expect(fs.statSync(binary).size).toBeGreaterThan(1024);
    }
  });

  it('每个开关都有静态依赖说明（避免新增开关时漏配自检）', () => {
    for (const key of BYPASS_KEYS) {
      const requirement = BYPASS_STATIC_REQUIREMENTS[key];
      expect(requirement, `缺少 ${key} 的依赖定义`).toBeTruthy();
      expect(requirement.note.length).toBeGreaterThan(0);
    }
  });
});
