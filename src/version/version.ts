// AudioTS 版本管理系统 — 版本号解析 / 格式化 / 递增 / 有效版本生成
import type { BumpLevel, VersionParts } from './types';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/** 解析 "5.15.42" 或 "5.15.42-rc1" */
export function parseVersion(s: string): VersionParts & { prerelease?: string } {
  const m = VERSION_RE.exec(s.trim());
  if (!m) throw new Error(`Invalid version string: ${s}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || undefined,
  };
}

/** 反向格式化，可附带预发布后缀 */
export function formatVersion(v: VersionParts, prerelease?: string): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return prerelease ? `${base}-${prerelease}` : base;
}

/**
 * 版本号递增（仿 Linux 内核语义）：
 * - patch：修订号 +1，其余不变
 * - minor：次版本号 +1，修订号归零
 * - major：主版本号 +1，次版本号与修订号均归零
 */
export function increment(v: VersionParts, level: BumpLevel): VersionParts {
  switch (level) {
    case 'patch':
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
    case 'minor':
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case 'major':
      return { major: v.major + 1, minor: 0, patch: 0 };
  }
}

/**
 * 生成有效版本号：
 * - 稳定分支（main/master）：MAJOR.MINOR.PATCH（无后缀）
 * - 开发分支：MAJOR.MINOR.PATCH-rcN（预发布标识）
 */
export function effectiveVersion(v: VersionParts, stable: boolean, prereleaseSeq: number): string {
  const base = formatVersion(v);
  if (stable) return base;
  return `${base}-rc${prereleaseSeq}`;
}
