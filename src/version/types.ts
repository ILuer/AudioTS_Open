// AudioTS 版本管理系统 — 类型定义
// 版本号格式：主版本号.次版本号.修订号（仿 Linux 内核语义化规则）

export type BumpLevel = 'major' | 'minor' | 'patch';

export type ChangeType =
  | 'major' // 重大架构变更（主版本号递增）
  | 'minor' // 新增功能 / 较大改动（次版本号递增）
  | 'patch' // 错误修复 / 安全补丁（修订号递增）
  | 'feat'
  | 'fix'
  | 'chore'
  | 'docs'
  | 'refactor'
  | 'rollback'; // 版本回退

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

export interface VersionEntry {
  /** 有效版本号，如 "5.15.42" 或 "5.15.42-rc1" */
  version: string;
  /** 不含预发布后缀的版本号，如 "5.15.42" */
  baseVersion: string;
  /** 更新日期 YYYY-MM-DD */
  date: string;
  type: ChangeType;
  description: string;
  /** 记录时的 git 分支 */
  branch: string;
  /** 预发布标识，如 "rc1"，稳定分支为 undefined */
  prerelease?: string;
}

export interface VersionStore {
  appName: string;
  current: VersionParts;
  history: VersionEntry[];
}
