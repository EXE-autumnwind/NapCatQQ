import { ConfigBase } from '@/napcat-core/helper/config-base';
import { NapCatCore } from '@/napcat-core/index';
import { Type, Static, TSchema } from '@sinclair/typebox';

import { Value } from '@sinclair/typebox/value';

import path from 'node:path';
import fs from 'node:fs';
import json5 from 'json5';
import { BypassOptionsSchema, DEFAULT_BYPASS_OPTIONS, normalizeBypassOptions } from './bypass';

export const NapcatConfigSchema = Type.Object({
  fileLog: Type.Boolean({ default: false }),
  consoleLog: Type.Boolean({ default: true }),
  fileLogLevel: Type.String({ default: 'debug' }),
  consoleLogLevel: Type.String({ default: 'info' }),
  packetBackend: Type.String({ default: 'auto' }),
  packetServer: Type.String({ default: '' }),
  o3HookMode: Type.Number({ default: 0 }),
  autoTimeSync: Type.Boolean({ default: true }),
  bypass: Type.Optional(BypassOptionsSchema),
});

export type NapcatConfig = Static<typeof NapcatConfigSchema>;

/**
 * 用 schema 归一化配置，并保证 bypass 一定存在且只含合法键。
 * 反检测开关散落在多个版本的历史配置里，未知键（拼错/遗留）不能带到原生模块。
 * 单个字段类型写错时只丢弃该字段（回落到默认值），不让整份配置失效。
 */
export function normalizeNapcatConfig (data: Record<string, unknown>): NapcatConfig {
  const normalized: Record<string, unknown> = { ...data };
  normalized['bypass'] = normalizeBypassOptions(data['bypass'] ?? DEFAULT_BYPASS_OPTIONS);
  try {
    return Value.Parse(NapcatConfigSchema, normalized) as NapcatConfig;
  } catch {
    const sanitized: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(NapcatConfigSchema.properties)) {
      if (key === 'bypass') continue;
      const value = normalized[key];
      if (value !== undefined && Value.Check(schema, value)) sanitized[key] = value;
    }
    sanitized['bypass'] = normalized['bypass'];
    return Value.Parse(NapcatConfigSchema, sanitized) as NapcatConfig;
  }
}

/**
 * 从指定配置目录读取 napcat.json，按 NapcatConfigSchema 校验并填充默认值
 * 用于登录前（无 NapCatCore 实例时）的早期配置读取
 */
export function loadNapcatConfig (configPath: string): NapcatConfig {
  let data: Record<string, unknown> = {};
  try {
    const configFile = path.join(configPath, 'napcat.json');
    if (fs.existsSync(configFile)) {
      data = json5.parse(fs.readFileSync(configFile, 'utf-8'));
    }
  } catch {
    // 读取失败时使用 schema 默认值
  }
  return normalizeNapcatConfig(data);
}

export class NapCatConfigLoader extends ConfigBase<NapcatConfig> {
  constructor (core: NapCatCore, configPath: string, schema: TSchema) {
    super('napcat', core, configPath, schema);
  }
}
