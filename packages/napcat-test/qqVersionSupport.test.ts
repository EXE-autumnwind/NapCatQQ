import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const appidTable = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/napcat-core/external/appid.json'), 'utf-8')) as Record<string, { appid: number; qua: string; }>;
const packetTable = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/napcat-core/external/packet.json'), 'utf-8')) as Record<string, { send: string; recv: string; }>;
const napiTable = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/napcat-core/external/napi2native.json'), 'utf-8')) as Record<string, { send: string; recv: string; }>;

const versions = Object.keys(appidTable);
const HEX = /^[0-9A-Fa-f]+$/;

describe('QQ 版本支持表', () => {
  it('每个 appid 条目都有数字 appid 与合规 qua', () => {
    for (const [version, entry] of Object.entries(appidTable)) {
      expect(Number.isInteger(entry.appid), `${version} appid 不是整数`).toBe(true);
      expect(entry.appid).toBeGreaterThan(0);
      expect(entry.qua, `${version} qua 缺失`).toMatch(/^V1_(WIN|MAC|LNX)_[A-Z]+_/);
      // qua 里至少要带版本号，避免复制粘贴时漏改（历史条目的构建号存在已知偏差，不强制）
      const [base] = version.split('-');
      expect(entry.qua, `${version} qua 未包含版本号`).toContain(base!);
    }
  });

  it('9.9.38-54985 的 appid/qua 与 major.node 提取结果一致', () => {
    expect(appidTable['9.9.38-54985']).toEqual({
      appid: 537404052,
      qua: 'V1_WIN_NQ_9.9.38_54985_GW_B',
    });
  });

  it('packet 表的偏移都是合法的十六进制 RVA', () => {
    for (const [key, entry] of Object.entries(packetTable)) {
      expect(key, `packet 键格式异常: ${key}`).toMatch(/^[\d.]+-\d+-(x64|arm64)$/);
      expect(entry.send, `${key} send 非法`).toMatch(HEX);
      expect(entry.recv, `${key} recv 非法`).toMatch(HEX);
      expect(parseInt(entry.send, 16)).toBeGreaterThan(0);
      expect(parseInt(entry.recv, 16)).toBeGreaterThan(0);
    }
  });

  it('napi2native 表的偏移都是合法的十六进制 RVA', () => {
    for (const [key, entry] of Object.entries(napiTable)) {
      expect(entry.send, `${key} send 非法`).toMatch(HEX);
      expect(entry.recv, `${key} recv 非法`).toMatch(HEX);
    }
  });

  it('9.9.38-54985 的 packet 偏移已登记', () => {
    expect(packetTable['9.9.38-54985-x64']).toEqual({ send: '2D86BDC', recv: '2D860FC' });
  });

  it('packet 表键唯一', () => {
    expect(new Set(Object.keys(packetTable)).size).toBe(Object.keys(packetTable).length);
  });

  it('新版本（9.9.38）已进入 appid 表，避免回落 appid 导致协议异常', () => {
    expect(versions).toContain('9.9.38-54985');
  });
});
