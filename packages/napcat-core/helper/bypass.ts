/**
 * 反检测（Bypass）配置的单一真源。
 *
 * 设计约定：
 * - 开关的键名、默认值、校验规则只在这里定义；config.ts、napi2nativeLoader.ts、
 *   shell/framework 启动流程、WebUI 后端都从这里取，避免多处维护后漂移。
 * - 本文件不允许 import napcat-core/index 或任何 native 模块，保持叶子模块，
 *   方便被 packet/handler、webui-backend 以及单元测试直接引用（不会产生循环依赖）。
 * - 真正生效的反检测逻辑在预编译的 napi2native 原生模块里（packages/napcat-native/napi2native），
 *   本仓库只负责：配置 → 校验 → 调用 → 记录结果。
 */
import { Static, Type } from '@sinclair/typebox';

/** 反检测开关的键名（顺序即 WebUI 展示与日志顺序） */
export const BYPASS_KEYS = ['hook', 'window', 'module', 'process', 'container', 'js'] as const;

export type BypassKey = (typeof BYPASS_KEYS)[number];

/**
 * 反检测开关的规范默认值：全部关闭。
 * 与随包发布的 napcat-core/external/napcat.json 保持一致（历史默认值是 true，
 * 与配置文件、WebUI 回显互相矛盾，已统一为 false）。
 */
export const DEFAULT_BYPASS_OPTIONS: Record<BypassKey, boolean> = {
  hook: false,
  window: false,
  module: false,
  process: false,
  container: false,
  js: false,
};

/** 反检测开关的校验 schema（键全为布尔，默认值取自 DEFAULT_BYPASS_OPTIONS） */
export const BypassOptionsSchema = Type.Object({
  hook: Type.Boolean({ default: DEFAULT_BYPASS_OPTIONS.hook }),
  window: Type.Boolean({ default: DEFAULT_BYPASS_OPTIONS.window }),
  module: Type.Boolean({ default: DEFAULT_BYPASS_OPTIONS.module }),
  process: Type.Boolean({ default: DEFAULT_BYPASS_OPTIONS.process }),
  container: Type.Boolean({ default: DEFAULT_BYPASS_OPTIONS.container }),
  js: Type.Boolean({ default: DEFAULT_BYPASS_OPTIONS.js }),
});

export type BypassOptions = Static<typeof BypassOptionsSchema>;

/** napi2native 提供反检测能力的平台（与 packages/napcat-native/napi2native 下的产物对应） */
export const SUPPORTED_BYPASS_PLATFORMS = [
  'win32.x64',
  'linux.x64',
  'linux.arm64',
  'darwin.x64',
  'darwin.arm64',
] as const;

/** 当前运行平台是否具备反检测能力 */
export function isSupportedBypassPlatform (platform: string = `${process.platform}.${process.arch}`): boolean {
  return (SUPPORTED_BYPASS_PLATFORMS as readonly string[]).includes(platform);
}

/** 环境变量：设为 1 时整体跳过反检测（排查问题时用） */
export const BYPASS_DISABLE_ENV = 'NAPCAT_DISABLE_BYPASS';

/** 是否为合法开关键 */
export function isBypassKey (key: string): key is BypassKey {
  return (BYPASS_KEYS as readonly string[]).includes(key);
}

/**
 * 归一化反检测开关：
 * - 只保留 BYPASS_KEYS 里的键，未知键丢弃（旧版本遗留/手改错别字不再写入原生模块）
 * - 布尔值原样保留；手改配置写成 "true"/"false" 字符串时按布尔解释
 * - 缺失或非法值回落到 DEFAULT_BYPASS_OPTIONS
 */
export function normalizeBypassOptions (raw?: unknown): BypassOptions {
  const normalized: BypassOptions = { ...DEFAULT_BYPASS_OPTIONS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalized;
  const record = raw as Record<string, unknown>;
  for (const key of BYPASS_KEYS) {
    const value = record[key];
    if (typeof value === 'boolean') {
      normalized[key] = value;
    } else if (value === 'true' || value === 'false') {
      normalized[key] = value === 'true';
    }
  }
  return normalized;
}

/** 列出 raw 中不被支持的键（用于 WebUI 保存时报错，而不是静默吞掉） */
export function findUnknownBypassKeys (raw?: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>).filter(key => !isBypassKey(key));
}

/** 把开关格式化成一行日志：hook=false,window=false,... */
export function formatBypassOptions (options: BypassOptions): string {
  return BYPASS_KEYS.map(key => `${key}=${options[key]}`).join(',');
}

/** 是否有任一开关处于开启状态 */
export function isAnyBypassEnabled (options: BypassOptions): boolean {
  return BYPASS_KEYS.some(key => options[key]);
}

/** 最近一次反检测应用结果（供 WebUI 展示，进程内单实例） */
export interface BypassApplyStatus {
  /** napi2native 是否加载成功 */
  moduleLoaded: boolean;
  /** 是否被 NAPCAT_DISABLE_BYPASS=1 跳过 */
  disabledByEnv: boolean;
  /** 原生模块是否确认接管（enableAllBypasses 返回 true） */
  applied: boolean;
  /** 配置文件里请求的开关 */
  requested: BypassOptions;
  /** 实际生效的开关（未生效时全部为 false） */
  effective: BypassOptions;
  /** 未生效原因 */
  error?: string;
  /** 记录时间戳（ms） */
  updatedAt: number;
}

let lastBypassStatus: BypassApplyStatus | null = null;

/** 读取最近一次应用结果；未调用过 applyBypass 时为 null */
export function getBypassStatus (): BypassApplyStatus | null {
  return lastBypassStatus;
}

/** 清空记录（测试用） */
export function resetBypassStatus (): void {
  lastBypassStatus = null;
}

export interface BypassLoggerLike {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
  logError: (...args: unknown[]) => void;
}

/** applyBypass 需要的原生模块最小接口（Napi2NativeLoader 结构兼容） */
export interface BypassLoaderLike {
  readonly loaded: boolean;
  readonly nativeExports: {
    enableAllBypasses?: (options?: BypassOptions) => boolean;
  };
}

/**
 * 应用反检测开关：统一的日志、异常兜底与状态记录。
 *
 * 永远不抛异常——反检测失败不应该阻断启动，但必须在日志与状态里说清楚，
 * 否则会变成"以为开着、实际没开"的静默降级。
 */
export function applyBypass (
  loader: BypassLoaderLike | null | undefined,
  bypass: unknown,
  logger?: BypassLoggerLike,
  env: Record<string, string | undefined> = process.env
): BypassApplyStatus {
  const requested = normalizeBypassOptions(bypass);
  const status: BypassApplyStatus = {
    moduleLoaded: loader?.loaded === true,
    disabledByEnv: env[BYPASS_DISABLE_ENV] === '1',
    applied: false,
    requested,
    effective: { ...DEFAULT_BYPASS_OPTIONS },
    updatedAt: Date.now(),
  };

  if (status.disabledByEnv) {
    logger?.log(`[Bypass] 已通过环境变量 ${BYPASS_DISABLE_ENV}=1 禁用（配置: ${formatBypassOptions(requested)}）`);
    lastBypassStatus = status;
    return status;
  }

  if (!status.moduleLoaded) {
    status.error = 'napi2native 未加载';
    logger?.logWarn('[Bypass] napi2native 未加载，反检测未生效（检查 packages/napcat-native/napi2native 是否随包发布）');
    lastBypassStatus = status;
    return status;
  }

  const enable = loader?.nativeExports.enableAllBypasses;
  if (typeof enable !== 'function') {
    status.error = 'napi2native 未导出 enableAllBypasses';
    logger?.logWarn('[Bypass] napi2native 未导出 enableAllBypasses，反检测未生效（原生模块版本与 JS 侧不匹配）');
    lastBypassStatus = status;
    return status;
  }

  try {
    status.applied = enable(requested) === true;
    if (status.applied) {
      status.effective = { ...requested };
      logger?.log(`[Bypass] 反检测已应用: ${formatBypassOptions(requested)}`);
    } else {
      status.error = 'enableAllBypasses 返回 false';
      logger?.logWarn(`[Bypass] 反检测未生效: enableAllBypasses 返回 false（配置: ${formatBypassOptions(requested)}）`);
    }
  } catch (error) {
    status.error = (error as Error)?.message ?? String(error);
    logger?.logError('[Bypass] 应用反检测失败:', error);
  }

  lastBypassStatus = status;
  return status;
}
