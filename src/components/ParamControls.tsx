/**
 * src/components/ParamControls.tsx — VoiceDesign 推理参数可视化控件（去 MUI 化）
 * ======================================================
 *
 * 目标 1（参数全可视化）：遍历 VOICE_DESIGN_PARAM_SPECS 自动渲染控件，
 * 按 advanced 标志分为基础参数（始终可见）和高级参数（折叠展开）。
 * 控件类型：number→原生 range + 数字输入；boolean→样式化 Switch；
 *          select→原生 select；text→原生 input/textarea。
 *
 * 用纯 HTML + 原型令牌（controls.css / global.css）重写，移除原 MUI 组件
 * （Box/Slider/Switch/Select/TextField/FormControlLabel/Chip/Alert/Button/Stack）及图标（改用 emoji）。
 * 高级参数折叠改用原生 <details>（复用 tuning.css 的 .collapse 规范）。
 * 参数描述直接显示在参数名后面，不再使用 Tooltip ⓘ。
 */

import { type FC, useState, type ReactNode } from 'react';
import { VOICE_DESIGN_PARAM_SPECS } from '@/pipeline/params';
import type { VoiceDesignParams, VoiceDesignParamSpec } from '@/types';
import '@/styles/controls.css';

interface ParamControlsProps {
  /** 当前参数值（受控） */
  params: VoiceDesignParams;
  /** 任一参数变更时回调，返回完整新对象 */
  onChange: (next: VoiceDesignParams) => void;
  /** 是否禁用全部控件（合成进行中） */
  disabled?: boolean;
  /** 渲染在基础参数和高级参数之间的内容（如合成按钮） */
  children?: ReactNode;
}

/** 更新单个字段 */
function setField(params: VoiceDesignParams, name: keyof VoiceDesignParams, value: unknown): VoiceDesignParams {
  return { ...params, [name]: value };
}

/** 通用滑块颜色编码：保守区=绿，中等区=橙，极端区=红 */
function getSliderColor(spec: VoiceDesignParamSpec, num: number): string {
  const min = spec.min ?? 0;
  const max = spec.max ?? 100;
  const range = max - min;
  const ratio = (num - min) / range;
  if (ratio <= 0.3) return '#4CAF50';
  if (ratio <= 0.7) return '#FF9800';
  return '#F44336';
}

/** 语速特殊颜色逻辑（与原 MUI 实现一致） */
function getSpeedColor(v: number): string {
  if (v <= 0.8) return '#FF9800';
  if (v <= 1.2) return '#4CAF50';
  if (v <= 1.4) return '#FF9800';
  return '#F44336';
}

export const ParamControls: FC<ParamControlsProps> = ({ params, onChange, disabled = false, children }) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 拆分基础参数和高级参数（均跳过 internal）
  const basicSpecs = VOICE_DESIGN_PARAM_SPECS.filter((s) => !s.internal && !s.advanced);
  const advancedSpecs = VOICE_DESIGN_PARAM_SPECS.filter((s) => !s.internal && s.advanced);

  return (
    <div className="param-controls">
      {/* ── 基础参数（始终可见）── */}
      <div className="param-list">
        {basicSpecs.map((spec) => (
          <ParamRow
            key={spec.name}
            spec={spec}
            value={params[spec.name]}
            disabled={disabled}
            onChange={(v) => onChange(setField(params, spec.name, v))}
          />
        ))}
      </div>

      {/* ── 基础/高级之间的插槽（合成按钮等）── */}
      {children}

      {/* ── 高级参数折叠（原生 details，复用 .collapse 规范）── */}
      <details
        className="collapse"
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          <span className="chev" aria-hidden="true">
            ▶
          </span>
          {showAdvanced ? '收起高级参数' : '展开高级参数'}
        </summary>
        <div className="adv-grid">
          <div className="alert alert-warning" style={{ gridColumn: '1 / -1' }}>
            <span className="a-ico" aria-hidden="true">
              ⚠️
            </span>
            <span>用户你好，以下是高阶参数，除非知道在做什么，否则请保持默认！</span>
          </div>
          {advancedSpecs.map((spec) => (
            <ParamRow
              key={spec.name}
              spec={spec}
              value={params[spec.name]}
              disabled={disabled}
              onChange={(v) => onChange(setField(params, spec.name, v))}
            />
          ))}
        </div>
      </details>
    </div>
  );
};

// ── 单行控件 ──

interface ParamRowProps {
  spec: VoiceDesignParamSpec;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}

const ParamRow: FC<ParamRowProps> = ({ spec, value, disabled, onChange }) => {
  // 参数名 + 内联描述
  const labelNode = (
    <span className="param-label">
      {spec.label}
      <span className="p-desc">{spec.desc}</span>
    </span>
  );

  // boolean → 样式化 Switch（替代 MUI Switch）
  if (spec.type === 'boolean') {
    return (
      <label className="param param-switch">
        <span className="switch">
          <input
            type="checkbox"
            checked={!!value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="track" aria-hidden="true" />
        </span>
        <span className="switch-label">{labelNode}</span>
      </label>
    );
  }

  // select → 原生 select（替代 MUI Select）
  if (spec.type === 'select') {
    return (
      <div className="param">
        {labelNode}
        <select
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {spec.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // text → 原生 input / textarea（替代 MUI TextField）
  if (spec.type === 'text') {
    return (
      <div className="param">
        {labelNode}
        {spec.name === 'instruct' ? (
          <textarea
            rows={2}
            value={String(value ?? '')}
            disabled={disabled}
            placeholder={spec.desc}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            type="text"
            value={String(value ?? '')}
            disabled={disabled}
            placeholder={spec.desc}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    );
  }

  // number / slider → 原生 range + 数字输入（替代 MUI Slider + TextField）
  if (spec.type !== 'number' && spec.type !== 'slider') return null;

  const num = Number(value);
  const min = spec.min ?? 0;
  const max = spec.max ?? 100;
  const step = spec.step ?? 1;
  const isFloat = step < 1;

  // 输入框显示值：浮点保留 2 位小数，整数直接显示
  const displayValue: number = Number.isFinite(num)
    ? isFloat
      ? parseFloat(num.toFixed(2))
      : Math.round(num)
    : 0;

  // 语速保持原有特殊颜色逻辑，高级滑块使用通用颜色编码
  const isSpeed = spec.name === 'speed';
  const isAdvancedSlider = spec.advanced && spec.type === 'slider';
  const sliderColor: string | undefined = isSpeed
    ? getSpeedColor(Number.isFinite(num) ? num : 1.0)
    : isAdvancedSlider
      ? getSliderColor(spec, Number.isFinite(num) ? num : (spec.default as number))
      : undefined;
  const rangeColor = sliderColor ?? 'var(--brand)';

  return (
    <div className="param">
      <div className="param-head">
        <span className="param-label">{spec.label}</span>
        <span className="param-num">
          <input
            type="number"
            value={displayValue}
            disabled={disabled}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(Number.isFinite(n) ? n : 0);
            }}
          />
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Number.isFinite(num) ? num : 0}
        style={{ accentColor: rangeColor }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {/* 语速颜色图例（替代 MUI Chip） */}
      {isSpeed && (
        <div className="legend">
          <span className="legend-chip" style={{ background: '#FF9800' }}>
            慢 0.50-0.80
          </span>
          <span className="legend-chip" style={{ background: '#4CAF50' }}>
            推荐 0.81-1.20
          </span>
          <span className="legend-chip" style={{ background: '#FF9800' }}>
            快 1.21-1.40
          </span>
          <span className="legend-chip" style={{ background: '#F44336' }}>
            极快 1.41-1.60
          </span>
        </div>
      )}
    </div>
  );
};

export default ParamControls;
