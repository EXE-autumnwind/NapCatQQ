/**
 * 反检测「静态可验证性」探测。
 *
 * 背景（逆向 QQ 9.9.37-54395 得到的事实，见 docs/bypass.md）：
 * - hook / module / process 三个开关是在 wrapper.node 的 IAT 上做 hook 的，
 *   依赖 wrapper.node 真的导入被 hook 的 API；QQ 换版本后不再导入某个 API，
 *   hook 就会静默失效（原生模块只会打一行 WARN，不会阻断启动）。
 * - window 开关伪造的是 Chromium base::PowerMonitor 的消息窗口类
 *   `Base_PowerMessageWindow`，该字符串在 QQ 运行时的 QQNT.dll 里（UTF-16）。
 * - js 开关针对 Node 运行时的 `NodeContextifyContextMetrics1`，同样在 QQNT.dll 里（ASCII）。
 *
 * 因此启动时按开关逐个核对"目标是否还在"，把静默失效变成可见告警。
 * 只读文件、不加载、不执行 QQ 的任何模块。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  BYPASS_KEYS,
  BypassApplyStatus,
  BypassKey,
  BypassLoaderLike,
  BypassLoggerLike,
  BypassOptions,
  applyBypass,
  formatBypassOptions,
  isAnyBypassEnabled,
  isSupportedBypassPlatform,
} from './bypass';
import { flattenImports, parsePeImportsFromFile } from './pe-imports';

export type BypassSignatureEncoding = 'ascii' | 'utf16le';

export interface BypassSignature {
  /** 到哪个 QQ 运行时文件里找 */
  file: 'QQNT.dll' | 'wrapper.node';
  pattern: string;
  encoding: BypassSignatureEncoding;
}

export interface BypassStaticRequirement {
  /** wrapper.node 导入表里必须出现的 API（大小写不敏感） */
  requiredImports: string[];
  /** 缺失只降级、不影响开关本身的 API */
  optionalImports: string[];
  /** 需要出现在 QQ 运行时文件里的字符串特征 */
  signatures: BypassSignature[];
  /** 该开关在原生模块里的实现要点（来自逆向，用于日志与文档） */
  note: string;
}

/**
 * 开关 → 依赖表。
 * 更新 QQ 版本后如果这里开始报 missing，说明 QQ 改了实现，反检测需要跟进。
 */
export const BYPASS_STATIC_REQUIREMENTS: Record<BypassKey, BypassStaticRequirement> = {
  hook: {
    requiredImports: ['VirtualQuery'],
    optionalImports: ['VirtualQueryEx'],
    signatures: [],
    note: 'IAT 伪装：hook wrapper.node 的 VirtualQuery，把 AllocationBase 指回 kernel32 并隐藏 RWX 页',
  },
  window: {
    requiredImports: [],
    optionalImports: [],
    signatures: [{ file: 'QQNT.dll', pattern: 'Base_PowerMessageWindow', encoding: 'utf16le' }],
    note: '窗口伪造：补建 Chromium base::PowerMonitor 的 Base_PowerMessageWindow',
  },
  module: {
    requiredImports: ['K32EnumProcessModules', 'GetModuleHandleW', 'GetModuleHandleExA'],
    optionalImports: [],
    signatures: [],
    note: '模块枚举隐藏：K32EnumProcessModules / GetModuleHandleW / GetModuleHandleExA 过滤注入模块',
  },
  process: {
    requiredImports: ['GetModuleFileNameW', 'GetModuleFileNameA'],
    optionalImports: [],
    signatures: [],
    note: '进程名伪装：GetModuleFileNameA/W 返回 QQ 自身路径',
  },
  container: {
    requiredImports: [],
    optionalImports: [],
    signatures: [],
    note: '容器特征处理在原生模块内部完成，没有可静态核对的外部特征',
  },
  js: {
    requiredImports: [],
    optionalImports: [],
    signatures: [{ file: 'QQNT.dll', pattern: 'NodeContextifyContextMetrics1', encoding: 'ascii' }],
    note: 'JS 反检测：hook NodeContextifyContextMetrics1 伪造 contextify 计数，并隐藏注入的 JS 清单',
  },
};

export type BypassProbeState = 'present' | 'partial' | 'missing' | 'unknown';

export interface BypassSwitchProbe {
  key: BypassKey;
  state: BypassProbeState;
  /** 缺失的依赖（API 名或签名），形如 wrapper.node!VirtualQuery */
  missing: string[];
  /** 人读结论 */
  detail: string;
}

export interface BypassProbeReport {
  platform: string;
  platformSupported: boolean;
  wrapperPath?: string;
  qqntPath?: string;
  /** wrapper.node 导入表统计，undefined 表示没读到 */
  wrapperImports?: { dlls: number; apis: number; };
  switches: Record<BypassKey, BypassSwitchProbe>;
  checkedAt: number;
  error?: string;
}

export interface BypassProbeOptions {
  /** wrapper.node 路径，默认读 NAPCAT_WRAPPER_PATH */
  wrapperPath?: string;
  /** QQNT.dll 路径，默认从 wrapper.node 的目录向上找 */
  qqntPath?: string;
  platform?: string;
  logger?: BypassLoggerLike;
  /** 只探测这些开关（通常传配置里开启的），为空则全部探测 */
  only?: BypassOptions;
}

const SIGNATURE_CHUNK_SIZE = 8 * 1024 * 1024;

let lastProbe: BypassProbeReport | null = null;

/** 最近一次探测结果（供 WebUI 展示） */
export function getBypassProbe (): BypassProbeReport | null {
  return lastProbe;
}

/** 清空探测结果（测试用） */
export function resetBypassProbe (): void {
  lastProbe = null;
  signatureCache.clear();
}

const signatureCache = new Map<string, number>();

/** 分块在文件里找字符串特征，返回首个命中的字节偏移，未命中返回 -1 */
export function scanFileForSignature (
  filePath: string,
  pattern: string,
  encoding: BypassSignatureEncoding
): number {
  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}|${stat.size}|${stat.mtimeMs}|${pattern}|${encoding}`;
  const cached = signatureCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const needle = Buffer.from(pattern, encoding === 'ascii' ? 'latin1' : 'utf16le');
  const overlap = Math.max(needle.length * 2, 64);
  const buffer = Buffer.alloc(SIGNATURE_CHUNK_SIZE + overlap);
  const fd = fs.openSync(filePath, 'r');
  let position = 0;
  let found = -1;
  try {
    while (position < stat.size) {
      const read = fs.readSync(fd, buffer, 0, SIGNATURE_CHUNK_SIZE, position);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read + Math.min(overlap, Math.max(0, stat.size - position - read)));
      const hit = chunk.indexOf(needle);
      if (hit >= 0) {
        found = position + hit;
        break;
      }
      position += Math.max(1, read - overlap);
    }
  } finally {
    fs.closeSync(fd);
  }
  signatureCache.set(cacheKey, found);
  return found;
}

/** 从 wrapper.node 所在目录向上查找 QQNT.dll */
export function findQQNTDll (wrapperPath?: string): string | undefined {
  if (!wrapperPath) return undefined;
  let dir = path.dirname(wrapperPath);
  for (let depth = 0; depth < 4; depth++) {
    const candidate = path.join(dir, 'QQNT.dll');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function probeSwitch (
  key: BypassKey,
  requirement: BypassStaticRequirement,
  context: {
    imports?: Map<string, string[]>;
    wrapperPath?: string;
    qqntPath?: string;
    wrapperImportError?: string;
  }
): BypassSwitchProbe {
  const missing: string[] = [];

  for (const api of requirement.requiredImports) {
    if (!context.imports) {
      missing.push(`wrapper.node!${api}（导入表不可读）`);
      continue;
    }
    if (!context.imports.has(api.toLowerCase())) missing.push(`wrapper.node!${api}`);
  }

  for (const signature of requirement.signatures) {
    const filePath = signature.file === 'QQNT.dll' ? context.qqntPath : context.wrapperPath;
    if (!filePath) {
      missing.push(`${signature.file}!${signature.pattern}（文件未找到）`);
      continue;
    }
    try {
      if (scanFileForSignature(filePath, signature.pattern, signature.encoding) < 0) {
        missing.push(`${signature.file}!${signature.pattern}`);
      }
    } catch (error) {
      missing.push(`${signature.file}!${signature.pattern}（读取失败: ${(error as Error).message}）`);
    }
  }

  if (requirement.requiredImports.length === 0 && requirement.signatures.length === 0) {
    return { key, state: 'unknown', missing: [], detail: requirement.note };
  }

  if (missing.length === 0) {
    return { key, state: 'present', missing, detail: requirement.note };
  }
  const hasConfirmedDependency = requirement.requiredImports.some(api => context.imports?.has(api.toLowerCase())) ||
    requirement.signatures.some(sig => !missing.some(m => m.startsWith(`${sig.file}!${sig.pattern}`)));
  return {
    key,
    state: hasConfirmedDependency ? 'partial' : 'missing',
    missing,
    detail: requirement.note,
  };
}

/**
 * 探测反检测在当前 QQ 版本上的可行性。
 * 任何异常都收敛成 report.error，不影响启动。
 */
export function probeBypassCompat (options: BypassProbeOptions = {}): BypassProbeReport {
  const platform = options.platform ?? `${process.platform}.${process.arch}`;
  const wrapperPath = options.wrapperPath ?? process.env['NAPCAT_WRAPPER_PATH'];
  const qqntPath = options.qqntPath ?? findQQNTDll(wrapperPath);
  const report: BypassProbeReport = {
    platform,
    platformSupported: isSupportedBypassPlatform(platform),
    wrapperPath,
    qqntPath,
    switches: {} as Record<BypassKey, BypassSwitchProbe>,
    checkedAt: Date.now(),
  };

  let imports: Map<string, string[]> | undefined;
  let wrapperImportError: string | undefined;
  const needsImports = BYPASS_KEYS.some(key => BYPASS_STATIC_REQUIREMENTS[key].requiredImports.length > 0 &&
    (!options.only || options.only[key]));
  if (needsImports) {
    if (!wrapperPath || !fs.existsSync(wrapperPath)) {
      wrapperImportError = 'wrapper.node 未找到';
    } else {
      try {
        const pe = parsePeImportsFromFile(wrapperPath);
        imports = flattenImports(pe);
        report.wrapperImports = { dlls: pe.imports.size, apis: imports.size };
      } catch (error) {
        wrapperImportError = (error as Error).message;
      }
    }
  }

  for (const key of BYPASS_KEYS) {
    if (options.only && !options.only[key]) continue;
    report.switches[key] = probeSwitch(key, BYPASS_STATIC_REQUIREMENTS[key], {
      imports,
      wrapperPath,
      qqntPath,
      wrapperImportError,
    });
  }

  const problems = Object.values(report.switches).filter(probe => probe.state === 'missing' || probe.state === 'partial');
  for (const probe of problems) {
    options.logger?.logWarn(
      `[Bypass] 反检测依赖缺失: ${probe.key} (${probe.state}) -> ${probe.missing.join(', ')}；` +
      '该开关可能已对当前 QQ 版本失效，请核对 docs/bypass.md 并更新原生模块'
    );
  }
  if (wrapperImportError) {
    report.error = wrapperImportError;
    options.logger?.logWarn(`[Bypass] 无法读取 wrapper.node 导入表: ${wrapperImportError}`);
  }

  lastProbe = report;
  return report;
}

/** 一行摘要，便于日志与 WebUI 展示 */
export function formatBypassProbeSummary (report: BypassProbeReport): string {
  const parts = BYPASS_KEYS
    .filter(key => report.switches[key])
    .map(key => `${key}=${report.switches[key].state}`);
  return parts.join(',');
}

export interface BypassRuntimeResult {
  status: BypassApplyStatus;
  probe: BypassProbeReport | null;
}

/**
 * 启动期的反检测入口：应用开关 + 静态可行性自检。
 *
 * shell 与 framework 两条启动路径都走这里，保证日志、状态与自检行为一致。
 * 没有任何开关被开启时跳过自检（不必为 200MB+ 的 QQNT.dll 付扫描成本）。
 */
export function initBypass (
  loader: BypassLoaderLike | null | undefined,
  bypass: unknown,
  logger?: BypassLoggerLike,
  options: { wrapperPath?: string; qqntPath?: string; platform?: string; } = {}
): BypassRuntimeResult {
  const status = applyBypass(loader, bypass, logger);

  let probe: BypassProbeReport | null = null;
  if (isAnyBypassEnabled(status.requested) && !status.disabledByEnv) {
    probe = probeBypassCompat({
      wrapperPath: options.wrapperPath,
      qqntPath: options.qqntPath,
      platform: options.platform,
      logger,
      only: status.requested,
    });
    logger?.log(`[Bypass] 静态自检: ${formatBypassProbeSummary(probe)}（配置: ${formatBypassOptions(status.requested)}）`);
  } else if (!isAnyBypassEnabled(status.requested)) {
    logger?.log('[Bypass] 所有反检测开关均关闭，跳过静态自检');
  }

  return { status, probe };
}
