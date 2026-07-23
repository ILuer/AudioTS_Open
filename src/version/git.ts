// AudioTS 版本管理系统 — git 分支关联
// 所有 git 调用均 try/catch 包裹，失败回退，绝不抛错中断主流程。
import { execSync } from 'child_process';

function safeExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 当前 git 分支名，失败回退 'main' */
export function getBranch(): string {
  return safeExec('git rev-parse --abbrev-ref HEAD') || 'main';
}

/** 是否为稳定分支（main / master） */
export function isStableBranch(branch: string): boolean {
  return branch === 'main' || branch === 'master';
}

/**
 * 预发布序号：取当前分支领先 origin/main 的提交数；
 * 失败则回退到领先本地 HEAD 的提交数；再失败回退 1。
 */
export function getPrereleaseSeq(_branch: string): number {
  const ahead =
    safeExec('git rev-list --count HEAD ^origin/main') ?? safeExec('git rev-list --count HEAD') ?? '1';
  const n = parseInt(ahead, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
