/**
 * src/components/TabBar.tsx — 水平选项卡栏
 *
 * 受控组件：value / onChange。渲染原型 .tabbar / .tab 语义类，
 * 激活态经 aria-selected + CSS 指示条表达。
 *
 * 本期两个 Tab：调音台 / 配音台（顺序与原型一致：调音台在前，配音台在后）。
 */

import { type FC } from 'react';

export interface TabItem {
  id: string;
  label: string;
  icon?: string;
}

interface TabBarProps {
  tabs: TabItem[];
  value: number;
  onChange: (index: number) => void;
}

export const TabBar: FC<TabBarProps> = ({ tabs, value, onChange }) => (
  <nav className="tabbar" role="tablist" aria-label="工作区切换">
    {tabs.map((tab, index) => (
      <button
        key={tab.id}
        className="tab"
        role="tab"
        id={`tab-${tab.id}`}
        aria-selected={value === index}
        aria-controls={`panel-${tab.id}`}
        onClick={() => onChange(index)}
      >
        {tab.icon && (
          <span className="t-ico" aria-hidden="true">{tab.icon}</span>
        )}
        <span>{tab.label}</span>
      </button>
    ))}
  </nav>
);

export default TabBar;
