/**
 * src/components/VoiceDesignTab.tsx — 调音台（原型风格 · 音色建档）
 *
 * 重写目标：将 MUI 版「音色建档」替换为原型 CSS 风格的调音台。
 *   - 左：音色档案卡片网格（.profile-grid / .profile-card）
 *   - 右：吸顶编辑器（.editor-sticky）含 名称/语言/风格维度 combobox/
 *        个性 checkbox 组/可编 instruct/语速/种子/高级参数折叠/备注/
 *        实时预览卡(.pv-card)/试听卡(.audition-card，真实 ONNX 推理)。
 *
 * 真实推理：试听/合成按钮调用 useVoiceDesign.startSynthesis（→ ttsPipelineV2.synthesize），
 * 得到真实 wavBlob → <audio> 播放 + 下载。禁止任何 mock / 模拟音频。
 *
 * 日志：交互反馈走 logger.interactive，异常走 logger.warn/error；禁止 console.*。
 */

import React, { type FC, useState, useEffect, useRef } from 'react';
import type { OrtSessionManager } from '@/core/ortSessionManager';
import { useVoiceDesign, type VoiceDesignState } from '@/hooks/useVoiceDesign';
import { useProfiles, createProfileId } from '@/hooks/useProfiles';
import {
  buildInstruct,
  DIALECT_OPTIONS,
  AGE_OPTIONS,
  GENDER_OPTIONS,
  PERSONALITY_GROUPS,
  LANGUAGE_OPTIONS,
  langLabel,
  type ComboOption,
} from '@/lib/buildInstruct';
import type { SynthesisProgress, VoiceDesignParams, VoiceProfile } from '@/types';
import { logger } from '@/core/logger';

interface VoiceDesignTabProps {
  sessionManager: OrtSessionManager | null;
  /** 模型文件是否已加载到内存（非是否校验通过） */
  buffersReady: boolean;
}

// ── 编辑器草稿 ──
interface Draft {
  id: string;
  name: string;
  language: string;
  dialect: string | null;
  age: string;
  gender: string;
  personality: string[];
  instruct: string;
  manualInstruct: boolean;
  speed: number;
  seed: number;
  temperature: number;
  topK: number;
  topP: number;
  repetitionPenalty: number;
  note: string;
  referenceAudio: string | null;
}

const DEFAULT_DRAFT: Draft = {
  id: '',
  name: '',
  language: 'chinese',
  dialect: null,
  age: '',
  gender: '',
  personality: [],
  instruct: '',
  manualInstruct: false,
  speed: 1,
  seed: 20240701,
  temperature: 0.9,
  topK: 20,
  topP: 0.85,
  repetitionPenalty: 1.05,
  note: '',
  referenceAudio: null,
};

/** 试听样本文本 */
const SAMPLE_AUDITION = '你好，我是这段配音的旁白，很高兴为你讲述这个故事。';

/** 性别 → 预览头像符号 */
function genderSymbol(gender: string): string {
  if (gender === '女声') return '♀';
  if (gender === '男声') return '♂';
  if (gender === '中性声') return '⚧';
  return '🎙';
}

/** VoiceProfile → Draft */
function toDraft(p: VoiceProfile): Draft {
  return {
    id: p.id,
    name: p.name,
    language: p.language || 'chinese',
    dialect: p.dialect ?? null,
    age: p.age ?? '',
    gender: p.gender ?? '',
    personality: [...(p.personality || [])],
    instruct: p.instruct || '',
    // 加载/保存后保持「实时重组」模式：维度改动即时反映到 instruct。
    // 档案原 instruct 仅作为初始展示值，一旦改动任意维度即按维度重算。
    // 这样可修复「加载音色档案后，再改年龄/性别/方言/个性，instruct 不再重组」的 Bug。
    manualInstruct: false,
    speed: p.speed,
    seed: p.seed,
    temperature: p.params.temperature,
    topK: p.params.topK,
    topP: p.params.topP,
    repetitionPenalty: p.params.repetitionPenalty,
    note: p.note || '',
    referenceAudio: p.referenceAudio ?? null,
  };
}

// ────────────────────────────────────────────────────────────
// 内部组件：ComboBox（单选 + 可选搜索）
// ────────────────────────────────────────────────────────────
interface ComboBoxProps {
  options: ComboOption[];
  value: string | null;
  placeholder?: string;
  search?: boolean;
  disabled?: boolean;
  onChange: (value: string, label: string) => void;
}

const ComboBox: FC<ComboBoxProps> = ({
  options,
  value,
  placeholder = '请选择…',
  search = false,
  disabled = false,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouse = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => (o.label || o.value).toLowerCase().includes(q))
    : options;

  // 分组
  const groups: { name: string | null; items: ComboOption[] }[] = [];
  for (const o of filtered) {
    const g = o.group ?? null;
    const last = groups[groups.length - 1];
    if (!last || last.name !== g) {
      groups.push({ name: g, items: [] });
    }
    groups[groups.length - 1].items.push(o);
  }

  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <div className={`combo${open ? ' open' : ''}`} ref={wrapRef} data-value={value ?? ''}>
      <button
        type="button"
        className="combo-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <span className="ct-main">
          {selected ? (
            <span className="ct-val">{selected.label || selected.value}</span>
          ) : (
            <span className="ct-ph">{placeholder}</span>
          )}
        </span>
        <span className="ct-chev">
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <div className="combo-panel" role="listbox">
        {search && (
          <div className="combo-search">
            <input
              type="text"
              placeholder="搜索…"
              aria-label="搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        <div className="combo-list">
          {filtered.length === 0 && <div className="combo-empty">未找到匹配项</div>}
          {groups.map((g, gi) => (
            <React.Fragment key={gi}>
              {g.name && <div className="combo-group">{g.name}</div>}
              {g.items.map((o) => (
                <div
                  key={o.value}
                  className={`combo-opt${o.value === value ? ' sel' : ''}`}
                  role="option"
                  aria-selected={o.value === value}
                  onClick={() => {
                    onChange(o.value, o.label || o.value);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <span className="opt-label">{o.label || o.value}</span>
                  <span className="opt-check">✓</span>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// 内部组件：CheckboxPanel（多选 + 搜索）
// ────────────────────────────────────────────────────────────
interface CheckboxPanelProps {
  groups: { name: string; items: string[] }[];
  value: string[];
  search?: boolean;
  onChange: (value: string[]) => void;
}

const CheckboxPanel: FC<CheckboxPanelProps> = ({ groups, value, search = true, onChange }) => {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  return (
    <div className="checkbox-panel">
      {search && (
        <div className="cbox-search">
          <input
            type="text"
            placeholder="搜索个性…"
            aria-label="搜索个性"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div id="personalityGroups">
        {groups.map((g, gi) => {
          const items = g.items.filter((it) => !q || it.toLowerCase().includes(q));
          if (q && items.length === 0) return null;
          return (
            <div className="cbox-group" key={gi} data-grp={gi}>
              <div className="cbox-gh">{g.name}</div>
              <div className="cbox-grid">
                {items.map((it) => (
                  <div
                    key={it}
                    className={`cbox-item${value.includes(it) ? ' sel' : ''}`}
                    role="checkbox"
                    aria-checked={value.includes(it)}
                    data-val={it}
                    onClick={() => toggle(it)}
                  >
                    <span className="cbox-mark">
                      <svg viewBox="0 0 12 12">
                        <path d="M2.5 6l2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="cbox-text">{it}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// 内部组件：ProfileCard（左侧音色卡片）
// ────────────────────────────────────────────────────────────
interface ProfileCardProps {
  profile: VoiceProfile;
  active: boolean;
  onEdit: (p: VoiceProfile) => void;
  onDelete: (p: VoiceProfile) => void;
  onListen: (p: VoiceProfile) => void;
}

const ProfileCard: FC<ProfileCardProps> = ({ profile, active, onEdit, onDelete, onListen }) => {
  const chips: string[] = [];
  if (profile.dialect && profile.dialect !== '普通话') chips.push(profile.dialect);
  if (profile.age) chips.push(profile.age);
  if (profile.gender) chips.push(profile.gender);
  (profile.personality || []).forEach((x) => chips.push(x));

  return (
    <div className={`profile-card${active ? ' active' : ''}`} onClick={() => onEdit(profile)}>
      <div className="pc-top">
        <div className="pc-avatar" aria-hidden="true">{genderSymbol(profile.gender)}</div>
        <div>
          <div className="pc-name">{profile.name}</div>
          <div className="pc-sub">
            语速 {Number(profile.speed).toFixed(2)}× · {langLabel(profile.language)}
          </div>
        </div>
      </div>
      <div className="pc-chips">
        {chips.length ? (
          chips.map((c) => (
            <span key={c} className="pc-chip">{c}</span>
          ))
        ) : (
          <span className="pc-sub">未设置风格标签</span>
        )}
      </div>
      <div className="pc-note">
        {profile.instruct ? `「${profile.instruct}」` : profile.note ? profile.note : '暂无备注'}
      </div>
      <div className="pc-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="编辑" aria-label="编辑" onClick={() => onEdit(profile)}>✎</button>
        <button className="icon-btn" title="删除" aria-label="删除" onClick={() => onDelete(profile)}>🗑</button>
        <button className="icon-btn" title="试听" aria-label="试听" onClick={() => onListen(profile)}>🔊</button>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// 内部组件：PreviewCard（实时预览卡）
// ────────────────────────────────────────────────────────────
interface PreviewCardProps {
  draft: Draft;
  instruct: string;
}

const PreviewCard: FC<PreviewCardProps> = ({ draft, instruct }) => {
  const name = draft.name.trim() || '未命名音色';
  const parts: string[] = [];
  if (draft.age) parts.push(draft.age);
  if (draft.gender) parts.push(draft.gender);
  const summary = parts.length ? parts.join(' · ') : '尚未选择声线';

  return (
    <div className="pv-card">
      <div className="pv-head">
        <div className="pv-avatar" aria-hidden="true">{genderSymbol(draft.gender)}</div>
        <div>
          <div className="pv-name">{name}</div>
          <div className="pv-sub">声音风格预览</div>
        </div>
      </div>
      <p className="pv-summary">{summary}</p>
      <div className="pv-grid">
        <div className="pv-row">
          <span className="pv-k">方言</span>
          <span className="pv-v">{draft.dialect && draft.dialect !== '普通话' ? draft.dialect : '—'}</span>
        </div>
        <div className="pv-row">
          <span className="pv-k">年龄</span>
          <span className="pv-v">{draft.age || '—'}</span>
        </div>
        <div className="pv-row">
          <span className="pv-k">性别</span>
          <span className="pv-v">{draft.gender || '—'}</span>
        </div>
        <div className="pv-row">
          <span className="pv-k">个性</span>
          <span className="pv-v">
            {draft.personality.length
              ? draft.personality.map((x) => (
                  <span key={x} className="pv-badge">{x}</span>
                ))
              : '—'}
          </span>
        </div>
      </div>
      <div className="pv-instruct-label">风格描述 · instruct</div>
      <div className="pv-instruct">{instruct || '（选择标签后自动生成）'}</div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// 内部组件：AuditionCard（试听卡，真实推理）
// ────────────────────────────────────────────────────────────
interface AuditionCardProps {
  text: string;
  onTextChange: (t: string) => void;
  onGenerate: () => void;
  onClear: () => void;
  state: VoiceDesignState;
  progress: SynthesisProgress;
  audioUrl: string | null;
  durationSec: number | undefined;
  error: string | null;
  name: string;
  instruct: string;
  onDownload: () => void;
}

const AuditionCard: FC<AuditionCardProps> = ({
  text,
  onTextChange,
  onGenerate,
  onClear,
  state,
  progress,
  audioUrl,
  durationSec,
  error,
  name,
  instruct,
  onDownload,
}) => {
  const synthesizing = state === 'synthesizing';
  return (
    <div className="panel audition-card">
      <div className="panel-title">
        <span className="idx">🔊</span>试听
        <span style={{ fontSize: 12, color: 'var(--text-soft)', fontWeight: 400 }}>
          用当前音色合成样本语音
        </span>
      </div>
      <div className="field">
        <label>试听文本</label>
        <textarea
          rows={3}
          value={text}
          placeholder="输入一句话，试听当前音色的合成效果，例如：你好，我是这段配音的旁白。"
          onChange={(e) => onTextChange(e.target.value)}
        />
      </div>
      <div className="audition-actions">
        <button className="btn btn-primary" onClick={onGenerate} disabled={synthesizing}>
          {synthesizing ? '▶ 合成中…' : '▶ 试听生成'}
        </button>
        <button className="btn btn-ghost" onClick={onClear}>清空</button>
      </div>

      {synthesizing && (
        <div style={{ marginTop: 12 }}>
          <div className="pbar">
            <i style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="pcount">{progress.message}</div>
        </div>
      )}

      <div className={`audition-result${audioUrl ? ' show' : ''}`}>
        {error ? (
          <div className="vd-error">⚠ {error}</div>
        ) : (
          <>
            <div className="ar-meta">
              <b>{name}</b> · <span>{instruct}</span>
            </div>
            {audioUrl && <audio controls src={audioUrl} />}
            {durationSec != null && (
              <div className="ar-note">时长约 {durationSec.toFixed(1)} 秒</div>
            )}
            {audioUrl && (
              <div className="audition-actions" style={{ marginTop: 10 }}>
                <button className="btn btn-secondary btn-sm" onClick={onDownload}>⬇ 下载 WAV</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// 内部组件：DeleteModal（删除确认）
// ────────────────────────────────────────────────────────────
interface DeleteModalProps {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}

const DeleteModal: FC<DeleteModalProps> = ({ name, onCancel, onConfirm }) => (
  <div
    className="modal-mask show"
    onClick={(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}
  >
    <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="cmTitle">
      <div className="m-ico" aria-hidden="true">⚠</div>
      <h3 id="cmTitle">删除音色档案？</h3>
      <p>确定要删除「{name}」吗？该操作不可撤销。</p>
      <div className="m-actions">
        <button className="btn btn-secondary" onClick={onCancel}>取消</button>
        <button className="btn btn-primary" onClick={onConfirm} style={{ background: 'var(--color-error)' }}>
          删除
        </button>
      </div>
    </div>
  </div>
);

// ────────────────────────────────────────────────────────────
// 主组件：VoiceDesignTab（调音台）
// ────────────────────────────────────────────────────────────
const VoiceDesignTab: FC<VoiceDesignTabProps> = ({ sessionManager, buffersReady }) => {
  const { profiles, save, remove } = useProfiles();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);

  const [showDelete, setShowDelete] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const { state, progress, result, error, startSynthesis, reset } = useVoiceDesign(
    sessionManager,
    buffersReady,
  );

  const [auditionText, setAuditionText] = useState<string>(SAMPLE_AUDITION);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // 合成结果 → 生成可播放/下载的 Blob URL
  useEffect(() => {
    if (result?.success && result.wavBlob) {
      const url = URL.createObjectURL(result.wavBlob);
      setAudioUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setAudioUrl(null);
    return undefined;
  }, [result]);

  // 删除弹窗：Esc 关闭
  useEffect(() => {
    if (!showDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowDelete(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showDelete]);

  // ── 派生 instruct ──
  const getEffectiveInstruct = (): string =>
    draft.manualInstruct
      ? draft.instruct
      : buildInstruct({
          dialect: draft.dialect,
          age: draft.age || null,
          gender: draft.gender || null,
          personality: draft.personality,
        });

  // ── 编辑器操作 ──
  const startNew = () => {
    setEditingId(null);
    setDraft({ ...DEFAULT_DRAFT });
    setShowDelete(false);
    setPendingDeleteId(null);
  };

  const loadProfileIntoDraft = (p: VoiceProfile) => {
    setEditingId(p.id);
    setDraft(toDraft(p));
  };

  const handleLanguageChange = (lang: string) => {
    setDraft((d) => {
      const next: Draft = { ...d, language: lang };
      if (lang !== 'chinese') next.dialect = null;
      // 改动维度 → 无条件重算 instruct，并切回「自动拼接」模式
      next.instruct = buildInstruct({
        dialect: next.dialect,
        age: next.age || null,
        gender: next.gender || null,
        personality: next.personality,
      });
      next.manualInstruct = false;
      return next;
    });
  };

  const handleDimChange = (v: string) => {
    setDraft((d) => {
      const next: Draft = { ...d, dialect: v || null };
      // 改动维度 → 无条件重算 instruct，并切回「自动拼接」模式
      next.instruct = buildInstruct({
        dialect: next.dialect,
        age: next.age || null,
        gender: next.gender || null,
        personality: next.personality,
      });
      next.manualInstruct = false;
      return next;
    });
  };

  const handleAgeOrGenderChange = (key: 'age' | 'gender', v: string) => {
    setDraft((d) => {
      const next: Draft = { ...d, [key]: v };
      // 改动维度 → 无条件重算 instruct，并切回「自动拼接」模式
      next.instruct = buildInstruct({
        dialect: next.dialect,
        age: next.age || null,
        gender: next.gender || null,
        personality: next.personality,
      });
      next.manualInstruct = false;
      return next;
    });
  };

  const handlePersonalityChange = (nextVal: string[]) => {
    setDraft((d) => {
      const next: Draft = { ...d, personality: nextVal };
      // 改动维度 → 无条件重算 instruct，并切回「自动拼接」模式
      next.instruct = buildInstruct({
        dialect: next.dialect,
        age: next.age || null,
        gender: next.gender || null,
        personality: nextVal,
      });
      next.manualInstruct = false;
      return next;
    });
  };

  const handleInstructChange = (text: string) => {
    setDraft((d) => ({ ...d, instruct: text, manualInstruct: text.trim().length > 0 }));
  };

  const handleRefAudio = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setDraft((d) => ({ ...d, referenceAudio: f ? f.name : null }));
    if (f) logger.interactive('Profile', '已记录参考音频', f.name);
  };

  const handleSave = () => {
    const name = draft.name.trim();
    if (!name) {
      logger.warn('Profile', '请填写音色名称（将作为配音台匹配 key）');
      return;
    }
    const profile: VoiceProfile = {
      id: editingId || createProfileId(),
      name,
      language: draft.language,
      dialect: draft.dialect,
      age: draft.age,
      gender: draft.gender,
      personality: [...draft.personality],
      instruct: draft.manualInstruct
        ? draft.instruct.trim()
        : buildInstruct({
            dialect: draft.dialect,
            age: draft.age || null,
            gender: draft.gender || null,
            personality: draft.personality,
          }) || '',
      speed: draft.speed,
      seed: draft.seed,
      params: {
        temperature: draft.temperature,
        topK: draft.topK,
        topP: draft.topP,
        repetitionPenalty: draft.repetitionPenalty,
      },
      note: draft.note.trim(),
      referenceAudio: draft.referenceAudio,
    };
    save(profile);
    setEditingId(profile.id);
    setDraft(toDraft(profile));
    logger.interactive('Profile', editingId ? '已更新音色档案' : '已新建音色档案', name);
  };

  const handleDeleteClick = (p: VoiceProfile) => {
    setPendingDeleteId(p.id);
    setShowDelete(true);
  };

  const confirmDelete = () => {
    if (pendingDeleteId) {
      remove(pendingDeleteId);
      if (editingId === pendingDeleteId) startNew();
      logger.interactive('Profile', '已删除音色档案');
    }
    setShowDelete(false);
    setPendingDeleteId(null);
  };

  // ── 真实试听推理 ──
  const runAudition = async (
    src: {
      language: string;
      instruct: string;
      speed: number;
      seed: number;
      temperature: number;
      topK: number;
      topP: number;
      repetitionPenalty: number;
    },
    text: string,
  ): Promise<void> => {
    if (!text.trim()) {
      logger.warn('VoiceDesign', '请先输入试听文本');
      return;
    }
    if (!buffersReady) {
      logger.error('VoiceDesign', '模型尚未加载，请刷新页面并在加载时选择模型目录后重试');
      return;
    }
    const params: VoiceDesignParams = {
      seed: src.seed,
      language: src.language,
      instruct: src.instruct,
      speed: src.speed,
      temperature: src.temperature,
      topK: src.topK,
      topP: src.topP,
      repetitionPenalty: src.repetitionPenalty,
    };
    try {
      await startSynthesis(text.trim(), src.language, src.instruct, params);
      logger.interactive('VoiceDesign', '已开始合成试听');
    } catch (err) {
      // startSynthesis 已记录错误日志，这里不重复输出 console.*
      logger.error('VoiceDesign', '试听合成失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleAuditionGenerate = () => {
    runAudition(
      {
        language: draft.language,
        instruct: getEffectiveInstruct(),
        speed: draft.speed,
        seed: draft.seed,
        temperature: draft.temperature,
        topK: draft.topK,
        topP: draft.topP,
        repetitionPenalty: draft.repetitionPenalty,
      },
      auditionText,
    );
  };

  const handleAuditionClear = () => {
    reset();
    setAuditionText('');
    setAudioUrl(null);
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    const safe = (draft.name.trim() || 'voicedesign').replace(/[^\w一-龥-]/g, '_');
    a.download = `${safe}_${draft.seed}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleListen = (p: VoiceProfile) => {
    runAudition(
      {
        language: p.language,
        instruct:
          p.instruct ||
          buildInstruct({
            dialect: p.dialect,
            age: p.age || null,
            gender: p.gender || null,
            personality: p.personality,
          }),
        speed: p.speed,
        seed: p.seed,
        temperature: p.params.temperature,
        topK: p.params.topK,
        topP: p.params.topP,
        repetitionPenalty: p.params.repetitionPenalty,
      },
      auditionText.trim() || SAMPLE_AUDITION,
    );
  };

  const effectiveInstruct = getEffectiveInstruct();

  // ── 渲染 ──
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">调音台</h1>
          <p className="page-sub">
            为每位角色建立可复用的音色档案，配音台将按角色名自动匹配调用
          </p>
        </div>
        <button className="btn btn-primary" onClick={startNew}>
          ＋ 新建音色档案
        </button>
      </div>

      <div className="tuning-grid">
        {/* 左：音色档案列表 */}
        <div>
          <div className="panel-title">
            <span className="idx">📁</span>音色档案
            <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 13 }}>
              {profiles.length ? `共 ${profiles.length} 个` : ''}
            </span>
          </div>
          {profiles.length === 0 ? (
            <div className="empty">
              <div className="e-ico" aria-hidden="true">🎙</div>
              <h2>还没有音色档案</h2>
              <p>为角色建立可复用的声音设定，配音台会自动按角色名匹配调用。</p>
              <button className="btn btn-primary btn-sm" onClick={startNew}>
                ＋ 新建第一个音色
              </button>
            </div>
          ) : (
            <div className="profile-grid">
              {profiles.map((p) => (
                <ProfileCard
                  key={p.id}
                  profile={p}
                  active={p.id === editingId}
                  onEdit={loadProfileIntoDraft}
                  onDelete={handleDeleteClick}
                  onListen={handleListen}
                />
              ))}
            </div>
          )}
        </div>

        {/* 右：编辑器 */}
        <div className="editor-sticky">
          <div className="panel">
            <div className="editor-head">
              <span className="eh-title">{editingId ? '编辑音色档案' : '新建音色档案'}</span>
              <span className="eh-mode">{editingId ? `· ${draft.name}` : ''}</span>
              {editingId && (
                <button className="btn btn-ghost btn-sm" onClick={startNew}>
                  取消
                </button>
              )}
            </div>

            {/* 实时预览卡 */}
            <PreviewCard draft={draft} instruct={effectiveInstruct} />

            {/* 名称 */}
            <div className="field">
              <label>
                音色名称 <span className="req">*</span>
              </label>
              <input
                type="text"
                value={draft.name}
                placeholder="例如：男主·林深（将作为配音台的匹配 key）"
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>

            {/* 语言 */}
            <div className="field">
              <label>说话语言</label>
              <select value={draft.language} onChange={(e) => handleLanguageChange(e.target.value)}>
                {LANGUAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 方言 */}
            <div className={`dim${draft.language !== 'chinese' ? ' disabled' : ''}`}>
              <div className="dim-head">
                <span className="dim-ico" aria-hidden="true">🗣</span>
                <span className="dim-name">方言</span>
                <span className="dim-meta">单选 · 仅中文</span>
                <span className="lock" style={{ display: draft.language !== 'chinese' ? 'inline' : 'none' }}>
                  非中文不可用
                </span>
              </div>
              <ComboBox
                options={DIALECT_OPTIONS}
                value={draft.dialect}
                placeholder="请选择方言"
                search
                disabled={draft.language !== 'chinese'}
                onChange={handleDimChange}
              />
            </div>

            {/* 年龄 */}
            <div className="dim">
              <div className="dim-head">
                <span className="dim-ico" aria-hidden="true">🎂</span>
                <span className="dim-name">年龄</span>
                <span className="dim-meta">单选</span>
              </div>
              <ComboBox
                options={AGE_OPTIONS}
                value={draft.age || null}
                placeholder="请选择年龄"
                onChange={(v) => handleAgeOrGenderChange('age', v)}
              />
            </div>

            {/* 性别 */}
            <div className="dim">
              <div className="dim-head">
                <span className="dim-ico" aria-hidden="true">⚧</span>
                <span className="dim-name">性别</span>
                <span className="dim-meta">单选</span>
              </div>
              <ComboBox
                options={GENDER_OPTIONS}
                value={draft.gender || null}
                placeholder="请选择性别"
                onChange={(v) => handleAgeOrGenderChange('gender', v)}
              />
            </div>

            {/* 个性 / 气质 */}
            <div className="dim">
              <div className="dim-head">
                <span className="dim-ico" aria-hidden="true">✨</span>
                <span className="dim-name">个性 / 气质</span>
                <span className="dim-meta">多选 · 可叠加</span>
              </div>
              <CheckboxPanel
                groups={PERSONALITY_GROUPS}
                value={draft.personality}
                onChange={handlePersonalityChange}
              />
            </div>

            {/* 可编辑 instruct */}
            <div className="field" style={{ marginTop: 14 }}>
              <label>
                风格描述（instruct）<span className="hint"> · 可手编</span>
              </label>
              <textarea
                value={draft.instruct}
                placeholder="选择上方标签自动生成，或在此直接输入，例如：用粤语说，沉稳的男声"
                onChange={(e) => handleInstructChange(e.target.value)}
              />
            </div>

            {/* 基础参数：语速 / 种子 */}
            <div className="field">
              <label>
                语速 <span style={{ color: 'var(--brand)', fontWeight: 700 }}>{draft.speed.toFixed(2)}×</span>
              </label>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={draft.speed}
                onChange={(e) => setDraft((d) => ({ ...d, speed: Number(e.target.value) }))}
              />
            </div>
            <div className="field">
              <label>
                随机种子 <span className="hint"> · 同种子 = 同音色</span>
              </label>
              <input
                type="number"
                value={draft.seed}
                min={0}
                step={1}
                onChange={(e) => setDraft((d) => ({ ...d, seed: Number(e.target.value) || 0 }))}
              />
            </div>

            {/* 高级参数（折叠） */}
            <details className="collapse">
              <summary>
                <span className="chev" aria-hidden="true">▶</span> 高级参数（采样）
              </summary>
              <div className="adv-grid">
                <div className="field" style={{ margin: 0 }}>
                  <label>
                    温度 <span className="hint">0.80–1.00</span>
                  </label>
                  <input
                    type="range"
                    min={0.8}
                    max={1}
                    step={0.01}
                    value={draft.temperature}
                    onChange={(e) => setDraft((d) => ({ ...d, temperature: Number(e.target.value) }))}
                  />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label>Top-K</label>
                  <input
                    type="number"
                    value={draft.topK}
                    min={0}
                    step={1}
                    onChange={(e) => setDraft((d) => ({ ...d, topK: Number(e.target.value) || 0 }))}
                  />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label>
                    Top-P <span className="hint">0.50–1.00</span>
                  </label>
                  <input
                    type="range"
                    min={0.5}
                    max={1}
                    step={0.01}
                    value={draft.topP}
                    onChange={(e) => setDraft((d) => ({ ...d, topP: Number(e.target.value) }))}
                  />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label>
                    重复惩罚 <span className="hint">1.00–2.00</span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={2}
                    step={0.01}
                    value={draft.repetitionPenalty}
                    onChange={(e) => setDraft((d) => ({ ...d, repetitionPenalty: Number(e.target.value) }))}
                  />
                </div>
              </div>
            </details>

            {/* 备注 */}
            <div className="field" style={{ marginTop: 14 }}>
              <label>备注信息</label>
              <textarea
                value={draft.note}
                placeholder="用途 / 试听感受 / 适用场景…"
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              />
            </div>

            {/* 参考音频（可选元数据） */}
            <div className="field">
              <label>
                参考音频（可选）<span className="hint"> · 仅记录文件名，真实声纹建模将于后续批次接入</span>
              </label>
              <input type="file" accept="audio/*" onChange={handleRefAudio} style={{ padding: 6 }} />
              {draft.referenceAudio && <span className="empty-note">已选择：{draft.referenceAudio}</span>}
            </div>

            {/* 保存 / 试听样本 */}
            <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
              <button className="btn btn-primary" onClick={handleSave}>
                💾 保存音色档案
              </button>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  runAudition(
                    {
                      language: draft.language,
                      instruct: effectiveInstruct,
                      speed: draft.speed,
                      seed: draft.seed,
                      temperature: draft.temperature,
                      topK: draft.topK,
                      topP: draft.topP,
                      repetitionPenalty: draft.repetitionPenalty,
                    },
                    SAMPLE_AUDITION,
                  )
                }
              >
                🔊 试听样本
              </button>
            </div>
          </div>

          {/* 试听卡片（真实推理） */}
          <AuditionCard
            text={auditionText}
            onTextChange={setAuditionText}
            onGenerate={handleAuditionGenerate}
            onClear={handleAuditionClear}
            state={state}
            progress={progress}
            audioUrl={audioUrl}
            durationSec={result?.durationSec}
            error={error}
            name={draft.name.trim() || '未命名音色'}
            instruct={effectiveInstruct}
            onDownload={handleDownload}
          />
        </div>
      </div>

      {/* 删除确认 Modal */}
      {showDelete && pendingDeleteId && (
        <DeleteModal
          name={profiles.find((p) => p.id === pendingDeleteId)?.name ?? ''}
          onCancel={() => {
            setShowDelete(false);
            setPendingDeleteId(null);
          }}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
};

export default VoiceDesignTab;
