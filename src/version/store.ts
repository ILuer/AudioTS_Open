// AudioTS 版本管理系统 — 版本存储（version.json）+ 变更记录编排
import fs from 'fs';
import path from 'path';
import type { BumpLevel, ChangeType, VersionEntry, VersionParts, VersionStore } from './types';
import { effectiveVersion, formatVersion, increment } from './version';
import { getBranch, getPrereleaseSeq, isStableBranch } from './git';
import { appendChangelog } from './changelog';

const DEFAULT_APP = 'AudioTS';
const DEFAULT_CURRENT: VersionParts = { major: 0, minor: 1, patch: 0 };

export function storePath(root: string): string {
  return path.join(root, 'version.json');
}

/** 加载版本存储；文件不存在则创建默认 store 并落盘 */
export function loadStore(root = process.cwd()): VersionStore {
  const p = storePath(root);
  if (fs.existsSync(p)) {
    const store = JSON.parse(fs.readFileSync(p, 'utf8')) as VersionStore;
    store.history = store.history || [];
    store.current = store.current || { ...DEFAULT_CURRENT };
    store.appName = store.appName || DEFAULT_APP;
    return store;
  }
  const store: VersionStore = {
    appName: DEFAULT_APP,
    current: { ...DEFAULT_CURRENT },
    history: [],
  };
  saveStore(store, root);
  return store;
}

export function saveStore(store: VersionStore, root = process.cwd()): void {
  const p = storePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * 递增版本号并记录一条变更到 history 与 CHANGELOG。
 * 分支决定预发布后缀：稳定分支无后缀，开发分支附加 -rcN。
 */
export function recordBump(
  store: VersionStore,
  level: BumpLevel,
  opts: { description: string; type?: ChangeType; branch?: string; root?: string },
): VersionEntry {
  const branch = opts.branch ?? getBranch();
  const stable = isStableBranch(branch);
  const seq = stable ? 0 : getPrereleaseSeq(branch);

  store.current = increment(store.current, level);
  const prerelease = stable ? undefined : `rc${seq}`;

  const entry: VersionEntry = {
    version: effectiveVersion(store.current, stable, seq),
    baseVersion: formatVersion(store.current),
    date: today(),
    type: opts.type ?? (level as ChangeType),
    description: opts.description,
    branch,
    prerelease,
  };

  store.history.push(entry);
  saveStore(store, opts.root ?? process.cwd());
  appendChangelog(entry, opts.root ?? process.cwd());
  return entry;
}

export function getHistory(store: VersionStore): VersionEntry[] {
  return store.history;
}

/** 按 baseVersion 或带后缀的完整版本号检索历史条目 */
export function findEntry(store: VersionStore, versionStr: string): VersionEntry | undefined {
  const target = versionStr.trim();
  return store.history.find((e) => e.version === target || e.baseVersion === target);
}

/** 回退到指定历史版本，并记录一条 rollback 类型变更 */
export function rollbackTo(store: VersionStore, versionStr: string, opts?: { root?: string }): VersionEntry {
  const target = findEntry(store, versionStr);
  if (!target) throw new Error(`Version not found in history: ${versionStr}`);

  const parts = parseBase(target.baseVersion);
  store.current = parts;

  const branch = getBranch();
  const stable = isStableBranch(branch);
  const seq = stable ? 0 : getPrereleaseSeq(branch);
  const prerelease = stable ? undefined : `rc${seq}`;

  const entry: VersionEntry = {
    version: effectiveVersion(parts, stable, seq),
    baseVersion: formatVersion(parts),
    date: today(),
    type: 'rollback',
    description: `回退至版本 ${target.baseVersion}（原记录：${target.description}）`,
    branch,
    prerelease,
  };

  store.history.push(entry);
  saveStore(store, opts?.root ?? process.cwd());
  appendChangelog(entry, opts?.root ?? process.cwd());
  return entry;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseBase(s: string): VersionParts {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) throw new Error(`Invalid base version: ${s}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
