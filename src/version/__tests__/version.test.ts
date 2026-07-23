import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseVersion, formatVersion, increment, effectiveVersion } from '../version';
import { loadStore, recordBump, rollbackTo, findEntry, getHistory } from '../store';
import { readChangelog } from '../changelog';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audiots-ver-'));
}

describe('version.increment', () => {
  it('patch +1, 其余不变', () => {
    expect(increment({ major: 5, minor: 15, patch: 42 }, 'patch')).toEqual({ major: 5, minor: 15, patch: 43 });
  });
  it('minor +1, 修订号归零', () => {
    expect(increment({ major: 5, minor: 15, patch: 42 }, 'minor')).toEqual({ major: 5, minor: 16, patch: 0 });
  });
  it('major +1, 次版本号与修订号均归零', () => {
    expect(increment({ major: 5, minor: 15, patch: 42 }, 'major')).toEqual({ major: 6, minor: 0, patch: 0 });
  });
});

describe('version.parse/format', () => {
  it('round trip 一致', () => {
    const v = { major: 5, minor: 15, patch: 42 };
    expect(parseVersion(formatVersion(v))).toEqual({ major: 5, minor: 15, patch: 42 });
  });
  it('解析带预发布后缀', () => {
    expect(parseVersion('5.15.42-rc1')).toEqual({ major: 5, minor: 15, patch: 42, prerelease: 'rc1' });
  });
});

describe('version.effectiveVersion', () => {
  const v = { major: 5, minor: 15, patch: 42 };
  it('稳定分支无后缀', () => expect(effectiveVersion(v, true, 0)).toBe('5.15.42'));
  it('开发分支带 -rcN', () => expect(effectiveVersion(v, false, 3)).toBe('5.15.42-rc3'));
});

describe('store.recordBump', () => {
  it('更新 current、追加 history 与 CHANGELOG，且四要素齐全', () => {
    const root = tmpRoot();
    const store = loadStore(root);
    expect(store.current).toEqual({ major: 0, minor: 1, patch: 0 });

    const entry = recordBump(store, 'minor', { description: '新增批量配音', type: 'feat', branch: 'main', root });
    expect(store.current).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(entry.version).toBe('0.2.0');
    expect(entry.prerelease).toBeUndefined();
    expect(getHistory(store)).toHaveLength(1);

    const log = readChangelog(root);
    expect(log).toContain('0.2.0');
    expect(log).toContain('新增批量配音');
    expect(log).toContain('类型: feat');
    expect(log).toContain('分支: main');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('开发分支记录带 -rcN 的有效版本号', () => {
    const root = tmpRoot();
    const store = loadStore(root);
    const entry = recordBump(store, 'patch', { description: 'dev fix', branch: 'feature/x', root });
    expect(entry.version).toMatch(/^0\.1\.1-rc\d+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('store.rollbackTo', () => {
  it('回退到目标版本并记录 rollback 条目', () => {
    const root = tmpRoot();
    const store = loadStore(root);
    recordBump(store, 'minor', { description: 'a', branch: 'main', root }); // 0.2.0
    recordBump(store, 'patch', { description: 'b', branch: 'main', root }); // 0.2.1

    const rb = rollbackTo(store, '0.2.0', { root });
    expect(store.current).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(rb.type).toBe('rollback');
    expect(getHistory(store).filter((e) => e.type === 'rollback')).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('store.findEntry', () => {
  it('按 baseVersion 或完整版本号命中', () => {
    const root = tmpRoot();
    const store = loadStore(root);
    recordBump(store, 'minor', { description: 'x', branch: 'main', root });
    expect(findEntry(store, '0.2.0')).toBeDefined();
    expect(findEntry(store, '9.9.9')).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
