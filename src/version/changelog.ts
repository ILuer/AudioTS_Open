// AudioTS 版本管理系统 — CHANGELOG 自动生成
import fs from 'fs';
import path from 'path';
import type { VersionEntry } from './types';

const HEADER = '# Changelog\n\nAudioTS 版本变更记录（最新在上）。版本号格式 MAJOR.MINOR.PATCH：主版本=重大架构变更，次版本=新增功能/较大改动，修订号=Bug 修复/安全补丁。\n';

export function changelogPath(root: string): string {
  return path.join(root, 'CHANGELOG.md');
}

/** 单条变更记录渲染为 Markdown（含版本号 / 日期 / 类型 / 说明 四要素） */
export function renderEntry(entry: VersionEntry): string {
  const pre = entry.prerelease ? ` (预发布: ${entry.prerelease})` : '';
  return [
    `## [${entry.version}] - ${entry.date}${pre}`,
    '',
    `- 类型: ${entry.type}`,
    `- 分支: ${entry.branch}`,
    `- 说明: ${entry.description}`,
    '',
  ].join('\n');
}

/**
 * 将一条变更记录追加到 CHANGELOG.md（最新在上，保留历史，不覆盖）。
 * 文件不存在时初始化为带标题的空 Changelog。
 */
export function appendChangelog(entry: VersionEntry, root = process.cwd()): string {
  const p = changelogPath(root);
  let content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : HEADER;

  // 在第一条 "## [" 之前插入（保持标题在最上方）
  const idx = content.indexOf('\n## [');
  let headerPart: string;
  let bodyPart: string;
  if (idx === -1) {
    headerPart = content.replace(/\s*$/, '');
    bodyPart = '';
  } else {
    headerPart = content.slice(0, idx).replace(/\s*$/, '');
    bodyPart = content.slice(idx);
  }

  const newContent = `${headerPart}\n\n${renderEntry(entry)}${
    bodyPart ? '\n' + bodyPart.replace(/^\n+/, '') : '\n'
  }`;

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, newContent, 'utf8');
  return newContent;
}

export function readChangelog(root = process.cwd()): string {
  const p = changelogPath(root);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
