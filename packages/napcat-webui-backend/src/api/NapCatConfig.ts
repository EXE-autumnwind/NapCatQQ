import { RequestHandler } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { webUiPathWrapper } from '@/napcat-webui-backend/index';
import { WebUiDataRuntime } from '@/napcat-webui-backend/src/helper/Data';
import { sendError, sendSuccess } from '@/napcat-webui-backend/src/utils/response';
import json5 from 'json5';

import { Value } from '@sinclair/typebox/value';
import { NapcatConfigSchema } from '@/napcat-core/helper/config';
import {
  BYPASS_KEYS,
  BYPASS_DISABLE_ENV,
  DEFAULT_BYPASS_OPTIONS,
  findUnknownBypassKeys,
  getBypassStatus,
  isSupportedBypassPlatform,
  normalizeBypassOptions,
} from '@/napcat-core/helper/bypass';
import { getBypassProbe } from '@/napcat-core/helper/bypass-probe';

// 动态获取 NapCat 配置默认值
function getDefaultNapcatConfig (): Record<string, unknown> {
  const data = Value.Parse(NapcatConfigSchema, {}) as Record<string, unknown>;
  // bypass 是可选字段，schema 不会补默认值；这里补全，保证前端永远拿到六个布尔开关
  data['bypass'] = normalizeBypassOptions(data['bypass']);
  return data;
}

/**
 * 校验并合并 napcat 配置补丁。
 * - bypass 按开关逐个合并（只改一个开关不会把其余开关重置）
 * - 未知的 bypass 键直接报错，避免拼写错误被静默写进配置文件
 * - 合并结果再过一遍 schema 校验
 */
function mergeNapcatConfig (
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): { config?: Record<string, unknown>; error?: string; } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'config is empty or invalid' };
  }

  const merged: Record<string, unknown> = { ...current, ...patch };

  if ('bypass' in patch) {
    const rawBypass = patch['bypass'];
    if (rawBypass !== undefined && (typeof rawBypass !== 'object' || rawBypass === null || Array.isArray(rawBypass))) {
      return { error: 'bypass must be an object' };
    }
    const unknownKeys = findUnknownBypassKeys(rawBypass);
    if (unknownKeys.length > 0) {
      return { error: `unknown bypass option: ${unknownKeys.join(', ')} (allowed: ${BYPASS_KEYS.join(', ')})` };
    }
    const bypassPatch = (rawBypass ?? {}) as Record<string, unknown>;
    for (const key of BYPASS_KEYS) {
      const value = bypassPatch[key];
      if (value !== undefined && typeof value !== 'boolean') {
        return { error: `bypass.${key} must be boolean` };
      }
    }
    merged['bypass'] = normalizeBypassOptions({ ...normalizeBypassOptions(current['bypass']), ...bypassPatch });
  } else {
    merged['bypass'] = normalizeBypassOptions(current['bypass']);
  }

  if ('o3HookMode' in patch) {
    const mode = patch['o3HookMode'];
    if (mode !== 0 && mode !== 1) return { error: 'o3HookMode must be 0 or 1' };
  }

  const errors = [...Value.Errors(NapcatConfigSchema, merged)];
  const first = errors[0];
  if (first) {
    return { error: `invalid config at ${first.path || '/'}: ${first.message}` };
  }

  return { config: merged };
}

/**
 * 获取 napcat 配置文件路径
 */
function getNapcatConfigPath (): string {
  return resolve(webUiPathWrapper.configPath, './napcat.json');
}

/**
 * 读取 napcat 配置
 */
function readNapcatConfig (): Record<string, unknown> {
  const configPath = getNapcatConfigPath();
  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      const merged = { ...getDefaultNapcatConfig(), ...json5.parse(content) };
      merged['bypass'] = normalizeBypassOptions(merged['bypass']);
      return merged;
    }
  } catch (_e) {
    // 读取失败，使用默认值
  }
  return { ...getDefaultNapcatConfig() };
}

/**
 * 写入 napcat 配置
 */
function writeNapcatConfig (config: Record<string, unknown>): void {
  const configPath = resolve(webUiPathWrapper.configPath, './napcat.json');
  mkdirSync(webUiPathWrapper.configPath, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// 获取 NapCat 配置
export const NapCatGetConfigHandler: RequestHandler = (_, res) => {
  try {
    const config = readNapcatConfig();
    return sendSuccess(res, config);
  } catch (e) {
    return sendError(res, 'Config Get Error: ' + (e as Error).message);
  }
};

// 设置 NapCat 配置
export const NapCatSetConfigHandler: RequestHandler = (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return sendError(res, 'config is empty or invalid');
    }

    // 读取当前配置并合并
    const currentConfig = readNapcatConfig();
    const { config, error } = mergeNapcatConfig(currentConfig, newConfig as Record<string, unknown>);
    if (!config) return sendError(res, error ?? 'config is invalid');

    writeNapcatConfig(config);
    return sendSuccess(res, null);
  } catch (e) {
    return sendError(res, 'Config Set Error: ' + (e as Error).message);
  }
};

/**
 * 反检测运行状态：
 * - status：本次启动实际调用结果（是否加载原生模块、是否被环境变量禁用、哪些开关生效）
 * - probe：按当前 QQ 版本做的静态可行性自检（依赖是否还在）
 * - config：配置文件里的开关（改动需重启生效）
 */
export const NapCatGetBypassStatusHandler: RequestHandler = (_, res) => {
  try {
    const config = readNapcatConfig();
    return sendSuccess(res, {
      status: getBypassStatus(),
      probe: getBypassProbe(),
      config: normalizeBypassOptions(config['bypass']),
      defaults: DEFAULT_BYPASS_OPTIONS,
      platform: `${process.platform}.${process.arch}`,
      platformSupported: isSupportedBypassPlatform(),
      disabledByEnv: process.env[BYPASS_DISABLE_ENV] === '1',
    });
  } catch (e) {
    return sendError(res, 'Bypass Status Error: ' + (e as Error).message);
  }
};

// ============================================================
// Per-UIN 配置（napcat_{uin}.json）—— 登录后配置
// ============================================================

function readUinConfig (uin: string): Record<string, unknown> {
  const uinPath = resolve(webUiPathWrapper.configPath, `./napcat_${uin}.json`);
  const fallbackPath = resolve(webUiPathWrapper.configPath, './napcat.json');
  const configPath = existsSync(uinPath) ? uinPath : fallbackPath;
  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      const merged = { ...getDefaultNapcatConfig(), ...json5.parse(content) };
      merged['bypass'] = normalizeBypassOptions(merged['bypass']);
      return merged;
    }
  } catch (_e) {
    // ignore
  }
  return { ...getDefaultNapcatConfig() };
}

function writeUinConfig (uin: string, config: Record<string, unknown>): void {
  const configPath = resolve(webUiPathWrapper.configPath, `./napcat_${uin}.json`);
  mkdirSync(webUiPathWrapper.configPath, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// 获取 per-uin NapCat 配置
export const NapCatGetUinConfigHandler: RequestHandler = (_, res) => {
  try {
    const isLogin = WebUiDataRuntime.getQQLoginStatus();
    if (!isLogin) return sendError(res, 'Not Login');
    const uin = WebUiDataRuntime.getQQLoginUin();
    return sendSuccess(res, readUinConfig(uin));
  } catch (e) {
    return sendError(res, 'Config Get Error: ' + (e as Error).message);
  }
};

// 设置 per-uin NapCat 配置
export const NapCatSetUinConfigHandler: RequestHandler = (req, res) => {
  try {
    const isLogin = WebUiDataRuntime.getQQLoginStatus();
    if (!isLogin) return sendError(res, 'Not Login');
    const uin = WebUiDataRuntime.getQQLoginUin();

    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return sendError(res, 'config is empty or invalid');
    }
    const patch = newConfig as Record<string, unknown>;
    if ('bypass' in patch) {
      const unknownKeys = findUnknownBypassKeys(patch['bypass']);
      if (unknownKeys.length > 0) {
        return sendError(res, `unknown bypass option: ${unknownKeys.join(', ')}`);
      }
      for (const key of BYPASS_KEYS) {
        const value = (patch['bypass'] as Record<string, unknown> | undefined)?.[key];
        if (value !== undefined && typeof value !== 'boolean') {
          return sendError(res, `bypass.${key} must be boolean`);
        }
      }
    }
    const currentConfig = readUinConfig(uin);
    const mergedConfig = { ...currentConfig, ...patch };
    mergedConfig['bypass'] = normalizeBypassOptions(
      'bypass' in patch
        ? { ...normalizeBypassOptions(currentConfig['bypass']), ...(patch['bypass'] as Record<string, unknown>) }
        : currentConfig['bypass']
    );
    writeUinConfig(uin, mergedConfig);
    return sendSuccess(res, null);
  } catch (e) {
    return sendError(res, 'Config Set Error: ' + (e as Error).message);
  }
};
