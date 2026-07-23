/**
 * src/hooks/useTheme.ts — 主题切换 Hook（暖白 / 暗色，localStorage 持久化）
 *
 * 读写 localStorage('audiots-theme')；在 <html> 上增删 'dark' 类。
 * 默认暖白（light）。与原型 theme-switch 行为一致。
 */

import { useState, useEffect, useCallback } from 'react';

export type ThemeMode = 'light' | 'dark';

/** localStorage 主题键（与原型保持一致） */
const STORAGE_KEY = 'audiots-theme';

/** 读取初始主题：优先 localStorage，缺失或非法时回退 light */
function getInitialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage 不可用（隐私模式等），忽略并回退默认
  }
  return 'light';
}

/** 将主题应用到 <html> 并持久化 */
function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 持久化失败时忽略（当前会话视觉仍生效）
  }
}

/**
 * 主题切换 Hook。
 * @returns theme 当前主题；setTheme 显式设置；toggleTheme 在 light/dark 间切换
 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /** 显式设置主题（如点击 ☀/🌙 按钮） */
  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
  }, []);

  /** 在 light / dark 间切换 */
  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, setTheme, toggleTheme };
}

export default useTheme;
