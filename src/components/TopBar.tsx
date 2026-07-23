/**
 * src/components/TopBar.tsx — 顶栏
 *
 * 左：品牌标记（gradient 方块 + 名称 "AudioTS 配音系统"）
 * 右：主题切换（☀/🌙 两态按钮，调用 useTheme）+ 用户 chip（"配音员"）
 *
 * 语义类取自原型 tokens.css（.topbar / .brand / .brand-mark / .theme-switch / .user）。
 */

import { type FC } from 'react';
import { useTheme } from '@/hooks/useTheme';

export const TopBar: FC = () => {
  const { theme, setTheme } = useTheme();

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">🎙</div>
        <div className="brand-name">AudioTS <b>配音工作室</b></div>
      </div>

      <div className="topbar-right">
        <div className="theme-switch" role="group" aria-label="主题切换">
          <button
            type="button"
            aria-label="暖白模式"
            title="暖白"
            className={theme === 'light' ? 'on' : ''}
            onClick={() => setTheme('light')}
          >
            ☀
          </button>
          <button
            type="button"
            aria-label="暗色模式"
            title="暗色"
            className={theme === 'dark' ? 'on' : ''}
            onClick={() => setTheme('dark')}
          >
            🌙
          </button>
        </div>
        <div className="user" title="当前用户：配音员">配音员</div>
      </div>
    </header>
  );
};

export default TopBar;
