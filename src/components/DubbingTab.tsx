/**
 * src/components/DubbingTab.tsx — 配音台（原型风格 · 批量真实配音）
 *
 * 原型 CSS 风格（dubbing.css），批量将文本行合成为真实语音：
 *   - ① 上传台词表（dropzone 粘贴 / 拖入 .txt + 模板侧栏）解析为 ScriptRow[]，
 *     按角色名精确匹配 useProfiles 音色档案（matchVoice）。
 *   - ② 批量配音：逐行串行调用真实 ONNX 推理（复用 TtsPipelineV2.synthesize，
 *     与调音台共用同一套管线），受 Worker 全局锁约束、内存守卫节流/暂停。
 *   - ③ 台词表：序号 / 角色 / 情绪 / 台词 / 关联音色（徽标五态）/ 状态 / 操作（试听·重新生成·下载·删除）。
 *   - ④ 批量下载：命名规则条 + 角色筛选 + 下载列表 + 全选 + 单下 & ZIP（极简 stored ZIP，无外部依赖）。
 *   - 底部试听面板（preview sheet）：真实音频播放 / 重新生成 / A·B 对比。
 *
 * 真实推理边界：所有「合成 / 重生成 / 下载」均来自真实管线产出，禁止任何 mock / 静音模拟。
 * 日志：仅 logger.interactive / warning / error；禁止 console.*。
 */

import React, { type FC, useState, useEffect, useRef, useCallback } from 'react';
import type { OrtSessionManager } from '@/core/ortSessionManager';
import { useProfiles } from '@/hooks/useProfiles';
import { Tokenizer } from '@/pipeline/tokenizer';
import { TtsPipelineV2 } from '@/pipeline/ttsPipelineV2';
import { BPE_VOCAB_PATH, BPE_MERGES_PATH, BPE_CONFIG_PATH } from '@/core/constants';
import type { ScriptRow, VoiceProfile, VoiceDesignParams } from '@/types';
import { logger } from '@/core/logger';
import { fileNameOf, downloadBlob, buildZip } from '@/lib/namingRule';
import { parseXlsx, downloadXlsxTemplate, type ParsedLine } from '@/lib/scriptXlsx';

interface DubbingTabProps {
  /** ORT Session 管理器（VoiceDesign 集），传入推理管线 */
  sessionManager: OrtSessionManager | null;
  /** 模型文件是否已加载到内存（非是否校验通过） */
  buffersReady: boolean;
}

// ── 示例台本 / 情绪选项（与原型一致） ──
const SAMPLE = `1-旁白-平静-在很久很久以前，云雾缭绕的山谷里，住着一位老药师。
2-男主·林深-悲伤-你终于来了。我还以为，你不会再回来了。
3-女主·苏晚-喜悦-有些话，我藏了整整三年，今天必须说出来。
4-反派·陈boss-愤怒-这座城市，从今往后，只姓陈。
5-路人甲-疑惑-先生，需要我帮忙搬东西吗？
6-旁白-平静-故事，才刚刚开始。`;

const EMOTION_OPTS = [
  '平静', '喜悦', '悲伤', '愤怒', '恐惧', '紧张', '惊喜', '疑惑',
  '温柔', '严肃', '俏皮', '坚定', '无奈', '怜悯', '嘲讽', '羞涩', '撒娇',
];

// ── 纯函数：解析 / 匹配 / instruct ──
// ParsedLine 现由 src/lib/scriptXlsx.ts 导出（txt 与 xlsx 解析共用同一结构）。

/** 解析台本：每行 `序号-角色-情绪-台词`（用「-」分隔） */
function parseScript(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const parts = t.split('-');
    if (parts.length < 4) {
      out.push({
        idx: i + 1,
        role: parts[1] ? parts[1].trim() : `第${i + 1}行`,
        emotion: '—',
        line: parts.slice(2).join('-').trim() || '（格式不完整）',
        malformed: true,
      });
      return;
    }
    const seq = Number(parts[0].trim());
    out.push({
      idx: Number.isFinite(seq) && seq > 0 ? seq : i + 1,
      role: parts[1].trim(),
      emotion: parts[2].trim(),
      line: parts.slice(3).join('-').trim(),
    });
  });
  return out;
}

/** 角色名精确匹配音色档案 */
function matchVoice(role: string, profiles: VoiceProfile[]): VoiceProfile | null {
  return profiles.find((p) => p.name === role) ?? null;
}

/** 确定性 instruct：档案 instruct + 情绪修饰 */
export function finalInstruct(row: ScriptRow, prof: VoiceProfile | null): string {
  const base = prof && prof.instruct ? prof.instruct : row.instruct || '';
  const emo = row.emotion && row.emotion !== '—' ? row.emotion : '';
  if (base && emo) return `${base}，带着${emo}的情绪`;
  if (base) return base;
  if (emo) return `${emo}地`;
  return '（未设置风格描述）';
}

/** 时长格式化 0:03 */
function formatDur(sec?: number): string {
  if (sec == null || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 通用 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 内存守卫：Chrome performance.memory 占比超阈值返回 true（非 Chrome 返回 false） */
function memoryHigh(): boolean {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (!mem || !mem.jsHeapSizeLimit) return false;
  return mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.85;
}

// ────────────────────────────────────────────────────────────
// 内部组件：ComboBox（单选 + 可选搜索 + mini 变体）
// ────────────────────────────────────────────────────────────
interface ComboBoxProps {
  options: { value: string; label: string }[];
  value: string | null;
  placeholder?: string;
  search?: boolean;
  disabled?: boolean;
  mini?: boolean;
  ariaLabel?: string;
  onChange: (value: string, label: string) => void;
}

const ComboBox: FC<ComboBoxProps> = ({
  options,
  value,
  placeholder = '请选择…',
  search = false,
  disabled = false,
  mini = false,
  ariaLabel,
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
  const filtered = q ? options.filter((o) => (o.label || o.value).toLowerCase().includes(q)) : options;
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <div className={`combo${mini ? ' mini' : ''}${open ? ' open' : ''}`} ref={wrapRef} data-value={value ?? ''}>
      <button
        type="button"
        className="combo-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
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
            <input type="text" placeholder="搜索…" aria-label="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        <div className="combo-list">
          {filtered.length === 0 && <div className="combo-empty">未找到匹配项</div>}
          {filtered.map((o) => (
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
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// 主组件：DubbingTab（配音台）
// ────────────────────────────────────────────────────────────
const DubbingTab: FC<DubbingTabProps> = ({ sessionManager, buffersReady }) => {
  const { profiles } = useProfiles();

  const [rows, setRows] = useState<ScriptRow[]>([]);
  const [scriptText, setScriptText] = useState<string>('');
  const [dubbing, setDubbing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseBanner, setPauseBanner] = useState<{ show: boolean; text: string }>({ show: false, text: '' });
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [zipBannerShow, setZipBannerShow] = useState(false);

  // 试听底部面板状态
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetRowIndex, setSheetRowIndex] = useState<number | null>(null);
  const [sheetMode, setSheetMode] = useState<'preview' | 'regen'>('preview');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [prevUrl, setPrevUrl] = useState<string | null>(null);
  const [regenVoiceId, setRegenVoiceId] = useState<string | null>(null);
  const [regenSpeed, setRegenSpeed] = useState(1);
  const [regenEmotion, setRegenEmotion] = useState<string | null>(null);
  const [regenInstruct, setRegenInstruct] = useState('');
  const [playing, setPlaying] = useState(false);
  const [audioProg, setAudioProg] = useState(0);
  const [showCompare, setShowCompare] = useState(false);

  // refs
  const rowsRef = useRef<ScriptRow[]>(rows);
  const profilesRef = useRef<VoiceProfile[]>(profiles);
  const cancelledRef = useRef(false);
  const pausedRef = useRef(false);
  const pipelineRef = useRef<TtsPipelineV2 | null>(null);
  const tokenizerRef = useRef<Tokenizer>(new Tokenizer());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const compareAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  // ── 真实推理管线（复用 TtsPipelineV2，与调音台同一套） ──
  const ensurePipeline = useCallback(async (): Promise<TtsPipelineV2> => {
    if (!sessionManager) throw new Error('SessionManager 未初始化');
    if (!buffersReady) throw new Error('模型尚未全部加载完成');
    const tokenizer = tokenizerRef.current;
    if (!tokenizer.isLoaded()) {
      const vocabData = (window as unknown as { __bpe_vocab_json?: string }).__bpe_vocab_json;
      const mergesData = (window as unknown as { __bpe_merges_txt?: string }).__bpe_merges_txt;
      const configData = (window as unknown as { __bpe_tokenizer_config_json?: string }).__bpe_tokenizer_config_json;
      if (vocabData && mergesData) {
        tokenizer.loadFromData(vocabData, mergesData, configData);
      } else {
        tokenizer.load(BPE_VOCAB_PATH, BPE_MERGES_PATH, BPE_CONFIG_PATH);
      }
    }
    if (!pipelineRef.current) pipelineRef.current = new TtsPipelineV2(sessionManager, tokenizer);
    return pipelineRef.current;
  }, [sessionManager, buffersReady]);

  const updateRow = useCallback((index: number, patch: Partial<ScriptRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  /** 真实合成单条（逐行串行调用，受 Worker 全局锁约束） */
  const synthesizeRow = useCallback(
    async (
      row: ScriptRow,
      onPct?: (pct: number) => void,
      instructOverride?: string,
    ): Promise<{ wav: Blob; durationSec: number }> => {
      const pipeline = await ensurePipeline();
      const prof = profilesRef.current.find((p) => p.id === row.voiceId) ?? null;
      const language = prof?.language || 'chinese';
      const instruct = instructOverride ?? finalInstruct(row, prof);
      const params: VoiceDesignParams = {
        seed: prof?.seed ?? 20240701,
        language,
        instruct,
        speed: prof?.speed ?? 1,
        temperature: prof?.params.temperature ?? 0.9,
        topK: prof?.params.topK ?? 20,
        topP: prof?.params.topP ?? 0.85,
        repetitionPenalty: prof?.params.repetitionPenalty ?? 1.05,
      };
      const ttsOutput = await pipeline.synthesize({
        text: row.text,
        language,
        instruct,
        seed: params.seed,
        speed: params.speed,
        temperature: params.temperature,
        topK: params.topK,
        topP: params.topP,
        repetitionPenalty: params.repetitionPenalty,
        onProgress: (pct: number) => {
          onPct?.(pct);
        },
      });
      return { wav: ttsOutput.wav, durationSec: ttsOutput.durationSec };
    },
    [ensurePipeline],
  );

  // ── ① 解析 / 加载台本 ──
  /** 将 ParsedLine[]（txt 或 xlsx）统一映射为 ScriptRow[]（保证结构一致） */
  const toScriptRows = (parsed: ParsedLine[]): ScriptRow[] => {
    return parsed.map((p) => {
      const prof = matchVoice(p.role, profilesRef.current);
      return {
        index: p.idx,
        role: p.role,
        emotion: p.emotion,
        text: p.line,
        voiceId: prof ? prof.id : null,
        voiceName: prof ? prof.name : null,
        instruct: prof ? prof.instruct : null,
        status: 'wait' as const,
        pct: 0,
      };
    });
  };

  /** 应用已解析的 ParsedLine[]（txt / xlsx 共用），设为当前台词表 */
  const applyParsed = useCallback((parsed: ParsedLine[]) => {
    const newRows = toScriptRows(parsed);
    setRows(newRows);
    setSelectedNames(new Set());
    setRoleFilter(null);
    if (parsed.some((p) => p.malformed)) {
      logger.warn('Dubbing', '部分行格式不完整（需 序号-角色-情绪-台词），已尽力解析');
    } else {
      logger.interactive('Dubbing', `已解析 ${newRows.length} 行台本`);
    }
  }, []);

  const loadScript = useCallback((text: string) => {
    applyParsed(parseScript(text));
  }, [applyParsed]);

  const handleParse = () => {
    const text = scriptText.trim();
    if (!text) {
      logger.warn('Dubbing', '请先粘贴或拖入台本');
      return;
    }
    loadScript(text);
  };

  const handleLoadSample = () => {
    setScriptText(SAMPLE);
    logger.interactive('Dubbing', '已填入示例台本，点击「解析台本」');
  };

  const handleDownloadTemplate = () => {
    const tpl =
      '序号-角色-情绪-台词\n' +
      '1-旁白-平静-在很久很久以前，云雾缭绕的山谷里，住着一位老药师。\n' +
      '2-男主·林深-悲伤-你终于来了。我还以为，你不会再回来了。';
    downloadBlob(new Blob([tpl], { type: 'text/plain;charset=utf-8' }), 'AudioTS_台词模板.txt');
    logger.interactive('Dubbing', '已下载标准模板（.txt，列：序号-角色-情绪-台词）');
  };

  const handleDownloadXlsxTemplate = () => {
    downloadXlsxTemplate();
    logger.interactive('Dubbing', '已下载标准模板（.xlsx，列：序号/角色/情绪/台词）');
  };

  const handleClearScript = () => {
    setRows([]);
    setScriptText('');
    setSelectedNames(new Set());
    setRoleFilter(null);
    cancelledRef.current = true;
    pausedRef.current = false;
    setDubbing(false);
    setPaused(false);
    setPauseBanner({ show: false, text: '' });
    logger.warn('Dubbing', '已清空台词表');
  };

  // 拖拽 / 选择文件：按扩展名分支读取（.xlsx/.xls 走表格解析，其余保持原 txt 逻辑）
  const readFile = (f: File) => {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      const r = new FileReader();
      r.onload = () => {
        try {
          const parsed = parseXlsx(r.result as ArrayBuffer);
          applyParsed(parsed);
          logger.interactive('Dubbing', `已导入 xlsx 台本 ${parsed.length} 行，已自动解析`);
        } catch (err) {
          logger.error('Dubbing', `xlsx 解析失败：${(err as Error).message}`);
        }
      };
      r.readAsArrayBuffer(f);
      return;
    }
    // 其它（含 .txt / 无扩展名）：保持原有 readAsText → setScriptText
    const r = new FileReader();
    r.onload = () => {
      setScriptText(String(r.result));
      logger.interactive('Dubbing', '已读取文件，点击「解析台本」');
    };
    r.readAsText(f);
  };

  // 拖拽读取（同时支持 .txt 与 .xlsx）
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  };

  // 点击「选择文件」时由隐藏 input 触发
  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) readFile(f);
    e.target.value = '';
  };

  // ── 关联音色 ──
  const onRowVoice = useCallback(
    (index: number, profileId: string) => {
      const prof = profilesRef.current.find((p) => p.id === profileId) ?? null;
      updateRow(index, {
        voiceId: prof?.id ?? null,
        voiceName: prof?.name ?? null,
        instruct: prof?.instruct ?? null,
      });
    },
    [updateRow],
  );

  const applyBatchVoice = useCallback((profileId: string) => {
    const prof = profilesRef.current.find((p) => p.id === profileId) ?? null;
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        voiceId: prof?.id ?? null,
        voiceName: prof?.name ?? null,
        instruct: prof?.instruct ?? null,
      })),
    );
    logger.interactive('Dubbing', `已将全部行关联为：${prof?.name ?? '—'}`);
  }, []);

  const deleteRow = useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── ② 批量配音（逐行串行 + 内存守卫节流/暂停） ──
  const runBatch = useCallback(async () => {
    if (!buffersReady) {
      logger.error('Dubbing', '模型尚未加载，请刷新页面并在加载时选择模型目录后重试');
      return;
    }
    const all = rowsRef.current;
    const queue = all
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.status === 'wait' || x.r.status === 'failed');
    if (queue.length === 0) {
      logger.warn('Dubbing', '没有待合成的台词行（请先解析台本，或行均已合成）');
      return;
    }
    cancelledRef.current = false;
    pausedRef.current = false;
    setDubbing(true);
    setPaused(false);
    setPauseBanner({ show: false, text: '' });
    logger.interactive('Dubbing', `开始批量配音（${queue.length} 行待合成）`);

    for (const { i } of queue) {
      if (cancelledRef.current) break;
      // 暂停等待（用户或内存守卫触发）
      while (pausedRef.current && !cancelledRef.current) await sleep(150);
      if (cancelledRef.current) break;
      // 内存守卫：偏高则自动暂停
      if (memoryHigh()) {
        pausedRef.current = true;
        setPaused(true);
        setPauseBanner({
          show: true,
          text: '内存使用率偏高，已自动暂停批量合成，释放后可点「继续」恢复。',
        });
        logger.warn('Dubbing', '内存使用率偏高，已自动暂停批量合成');
        while (pausedRef.current && !cancelledRef.current) await sleep(150);
        if (cancelledRef.current) break;
      }

      const row = rowsRef.current[i];
      if (!row.voiceId) {
        updateRow(i, { status: 'failed', error: '未关联音色，请先在「关联音色」选择' });
        logger.warn('Dubbing', `第 ${row.index} 行未关联音色，已跳过`);
        continue;
      }
      updateRow(i, { status: 'processing', error: undefined, pct: 0, wavBlob: undefined, durationSec: undefined });
      try {
        const { wav, durationSec } = await synthesizeRow(row, (pct) => updateRow(i, { pct }));
        updateRow(i, { status: 'done', wavBlob: wav, durationSec, pct: 100, error: undefined });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.error('Dubbing', `第 ${row.index} 行合成失败`, m);
        updateRow(i, { status: 'failed', error: m });
      }
      await sleep(0); // 让出事件循环，缓解长文本表内存压力
    }

    setDubbing(false);
    setPaused(false);
    setPauseBanner({ show: false, text: '' });
    if (!cancelledRef.current) {
      const done = rowsRef.current.filter((r) => r.status === 'done').length;
      logger.interactive('Dubbing', `批量配音完成：${done} / ${rowsRef.current.length} 行已合成`);
    }
  }, [buffersReady, synthesizeRow, updateRow]);

  const togglePause = useCallback(() => {
    if (!dubbing) return;
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      setPauseBanner({ show: false, text: '' });
      logger.interactive('Dubbing', '已恢复批量配音');
    } else {
      pausedRef.current = true;
      setPaused(true);
      setPauseBanner({ show: true, text: '批量任务已暂停，可点击「继续」恢复合成。' });
      logger.warn('Dubbing', '批量任务已暂停');
    }
  }, [dubbing]);

  const cancelBatch = useCallback(() => {
    cancelledRef.current = true;
    pausedRef.current = false;
    setDubbing(false);
    setPaused(false);
    setPauseBanner({ show: false, text: '' });
    rowsRef.current.forEach((r, i) => {
      if (r.status === 'processing') updateRow(i, { status: 'wait', pct: 0, error: undefined });
    });
    logger.interactive('Dubbing', '已取消批量配音');
  }, [updateRow]);

  // ── ③ 行内操作：试听 / 重新生成 / 下载 / 重试 / 删除 ──
  const downloadRow = useCallback((row: ScriptRow) => {
    if (!row.wavBlob) {
      logger.warn('Dubbing', '该台词尚未合成，无法下载');
      return;
    }
    const name = fileNameOf(row);
    downloadBlob(row.wavBlob, name);
    logger.interactive('Dubbing', `已下载 ${name}`);
  }, []);

  const retryRow = useCallback(
    async (index: number) => {
      if (!buffersReady) {
        logger.error('Dubbing', '模型尚未加载，请刷新页面并在加载时选择模型目录后重试');
        return;
      }
      const row = rowsRef.current[index];
      if (!row || !row.voiceId) {
        logger.warn('Dubbing', '未关联音色，无法重试');
        return;
      }
      updateRow(index, { status: 'processing', error: undefined, pct: 0 });
      try {
        const { wav, durationSec } = await synthesizeRow(row, (pct) => updateRow(index, { pct }));
        updateRow(index, { status: 'done', wavBlob: wav, durationSec, pct: 100 });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.error('Dubbing', `第 ${row.index} 行重试失败`, m);
        updateRow(index, { status: 'failed', error: m });
      }
    },
    [buffersReady, synthesizeRow, updateRow],
  );

  // ── 试听底部面板 ──
  const openSheet = useCallback((index: number, mode: 'preview' | 'regen') => {
    const row = rowsRef.current[index];
    if (!row) return;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current);
      prevUrlRef.current = null;
    }
    setSheetRowIndex(index);
    setSheetMode(mode);
    setSheetOpen(true);
    const prof = profilesRef.current.find((p) => p.id === row.voiceId) ?? null;
    setRegenVoiceId(row.voiceId);
    setRegenSpeed(1);
    setRegenEmotion(row.emotion !== '—' ? row.emotion : null);
    setRegenInstruct(finalInstruct(row, prof));
    setPlaying(false);
    setAudioProg(0);
    setShowCompare(false);
    if (row.wavBlob) {
      const url = URL.createObjectURL(row.wavBlob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  }, []);

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    audioRef.current?.pause();
    compareAudioRef.current?.pause();
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current);
      prevUrlRef.current = null;
    }
    setPreviewUrl(null);
    setPrevUrl(null);
    setPlaying(false);
    setAudioProg(0);
  }, []);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !previewUrl) return;
    if (a.paused) a.play().catch(() => undefined);
    else a.pause();
  }, [previewUrl]);

  // 重新生成（真实推理，覆盖 instruct）
  const handleRegen = useCallback(async () => {
    if (sheetRowIndex === null) return;
    const prof = profilesRef.current.find((p) => p.id === regenVoiceId) ?? null;
    if (!prof) {
      logger.warn('Dubbing', '请先选择关联音色');
      return;
    }
    const baseRow = rowsRef.current[sheetRowIndex];
    if (!baseRow) return;
    const tmpRow: ScriptRow = {
      ...baseRow,
      voiceId: prof.id,
      voiceName: prof.name,
      emotion: regenEmotion && regenEmotion !== '—' ? regenEmotion : baseRow.emotion,
      instruct: regenInstruct,
    };
    // 旧版存为「上一版」供对比
    if (previewUrlRef.current) {
      prevUrlRef.current = previewUrlRef.current;
      setPrevUrl(previewUrlRef.current);
    }
    logger.interactive('Dubbing', '正在重新生成…');
    try {
      const { wav, durationSec } = await synthesizeRow(tmpRow, undefined, regenInstruct);
      updateRow(sheetRowIndex, {
        voiceId: prof.id,
        voiceName: prof.name,
        emotion: tmpRow.emotion,
        instruct: regenInstruct,
        status: 'done',
        wavBlob: wav,
        durationSec,
        pct: 100,
        error: undefined,
      });
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(wav);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setShowCompare(true);
      logger.interactive('Dubbing', '当前版已生成（可与原版对比）');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error('Dubbing', `第 ${baseRow.index} 行重新生成失败`, m);
    }
  }, [sheetRowIndex, regenVoiceId, regenEmotion, regenInstruct, synthesizeRow, updateRow]);

  const playPrev = () => {
    const a = compareAudioRef.current;
    if (!prevUrl || !a) return;
    a.src = prevUrl;
    a.play().catch(() => undefined);
  };
  const playCur = () => {
    const a = compareAudioRef.current;
    if (!previewUrl || !a) return;
    a.src = previewUrl;
    a.play().catch(() => undefined);
  };

  // ── ④ 批量下载 ──
  const doneRows = rows.filter((r) => r.status === 'done' && r.wavBlob);
  const fileListRows = roleFilter ? doneRows.filter((r) => r.role === roleFilter) : doneRows;

  const toggleSelect = useCallback((name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedNames((prev) => {
      if (prev.size === fileListRows.length && fileListRows.length > 0) return new Set();
      return new Set(fileListRows.map((r) => fileNameOf(r)));
    });
  }, [fileListRows]);

  const handleDownloadAll = useCallback(() => {
    const done = rowsRef.current.filter((r) => r.status === 'done' && r.wavBlob);
    if (done.length === 0) {
      logger.warn('Dubbing', '暂无可下载文件');
      return;
    }
    const sel = done.filter((r) => selectedNames.has(fileNameOf(r)));
    const targets = sel.length ? sel : done;
    if (!sel.length) logger.interactive('Dubbing', '未选择，将下载全部已合成文件');
    targets.forEach((r, k) => {
      setTimeout(() => {
        if (r.wavBlob) downloadBlob(r.wavBlob, fileNameOf(r));
      }, k * 200);
    });
    logger.interactive('Dubbing', `已触发下载 ${targets.length} 个文件`);
  }, [selectedNames]);

  const doZip = useCallback(async () => {
    const done = rowsRef.current.filter((r) => r.status === 'done' && r.wavBlob);
    const sel = done.filter((r) => selectedNames.has(fileNameOf(r)));
    const targets = sel.length ? sel : done;
    try {
      const files = await Promise.all(
        targets.map(async (r) => ({
          name: fileNameOf(r),
          data: new Uint8Array(await (r.wavBlob as Blob).arrayBuffer()),
        })),
      );
      const zip = buildZip(files);
      downloadBlob(new Blob([zip as unknown as BlobPart], { type: 'application/zip' }), 'AudioTS_配音导出.zip');
      logger.interactive('Dubbing', `已下载 ZIP（${files.length} 个文件）`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error('Dubbing', '打包失败，已改为逐条下载', m);
      targets.forEach((r, k) => {
        setTimeout(() => {
          if (r.wavBlob) downloadBlob(r.wavBlob, fileNameOf(r));
        }, k * 200);
      });
    }
    setZipBannerShow(false);
  }, [selectedNames]);

  const handleDownloadZip = useCallback(() => {
    const done = rowsRef.current.filter((r) => r.status === 'done' && r.wavBlob);
    if (done.length === 0) {
      logger.warn('Dubbing', '暂无可打包文件');
      return;
    }
    const selCount = selectedNames.size;
    const count = selCount ? selCount : done.length;
    logger.interactive('Dubbing', `整包约 ${Math.max(1, Math.round(count * 0.06))}MB / ${count} 个文件，确认下载？`);
    setZipBannerShow(true);
  }, [selectedNames]);

  // 派生：总进度
  const total = rows.length;
  const doneCount = rows.filter((r) => r.status === 'done').length;
  const failCount = rows.filter((r) => r.status === 'failed').length;
  const totalPct = total ? Math.round((doneCount / total) * 100) : 0;
  const totalText =
    dubbing || doneCount || paused
      ? `已合成 ${doneCount} / ${total} 行${failCount ? ` · ${failCount} 失败` : ''}`
      : `等待开始 · 0 / ${total} 行`;

  // 试听面板当前行
  const sheetRow = sheetRowIndex !== null ? rows[sheetRowIndex] : null;

  // 选项
  const voiceOptions = profiles.map((p) => ({ value: p.id, label: p.name }));
  const roleOptions = ['全部角色', ...Array.from(new Set(rows.map((r) => r.role)))];
  const emotionOptions = EMOTION_OPTS.map((e) => ({ value: e, label: e }));

  // 渲染：状态单元格
  const renderStatus = (r: ScriptRow) => {
    if (r.status === 'wait') {
      return r.voiceId ? (
        <span className="badge badge-linked">
          <span className="dot" />
          已关联
        </span>
      ) : (
        <span className="badge badge-unlinked">
          <span className="dot" />
          未关联
        </span>
      );
    }
    if (r.status === 'processing')
      return (
        <span className="st st-processing">
          <span className="spinner" />
          合成中 {Math.floor(r.pct ?? 0)}%
        </span>
      );
    if (r.status === 'done') return <span className="st st-done">✓ 完成</span>;
    if (r.status === 'failed')
      return (
        <span className="st st-failed">
          ✗ 失败
          <button
            className="btn btn-ghost btn-sm"
            style={{ height: 24, padding: '0 8px', fontSize: 12, marginLeft: 4 }}
            onClick={() => retryRow(rows.indexOf(r))}
          >
            重试
          </button>
        </span>
      );
    return (
      <span className="badge badge-unlinked">
        <span className="dot" />
        未关联
      </span>
    );
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">配音台</h1>
          <p className="page-sub">上传整本台词 · 按角色自动关联音色 · 批量合成 · 逐行精修试听</p>
        </div>
        <button className="btn btn-primary" onClick={runBatch}>
          ▶ 开始配音
        </button>
        <button className="btn btn-ghost btn-sm" onClick={handleClearScript}>
          清空台词
        </button>
      </div>

      {/* 限制 Banner（暂停 / 内存守卫） */}
      <div className={`banner${pauseBanner.show ? ' show' : ''}`}>
        <span aria-hidden="true">⏸</span>
        <span>{pauseBanner.text}</span>
        <button className="btn btn-secondary btn-sm" onClick={togglePause}>
          {paused ? '▶ 继续' : '⏸ 暂停'}
        </button>
        <button
          className="b-close"
          aria-label="关闭横幅"
          onClick={() => setPauseBanner({ show: false, text: '' })}
        >
          ✕
        </button>
      </div>

      {/* ① 上传台词表 */}
      <section className="panel">
        <h2 className="panel-title">
          <span className="idx">①</span>上传台词表
        </h2>
        <div className="upload">
          <div
            className={`dropzone${dragActive ? ' drag' : ''}`}
            ref={dropzoneRef}
            tabIndex={0}
            aria-label="粘贴或拖入台词文本"
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            <div className="dropzone-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                📂 选择 .txt / .xlsx 文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.xlsx"
                style={{ display: 'none' }}
                onChange={handleFilePick}
              />
            </div>
            <textarea
              value={scriptText}
              placeholder="在此粘贴台本，每行：序号 - 角色 - 情绪 - 台词&#10;或把 .txt / .xlsx 文件拖到这里"
              spellCheck={false}
              onChange={(e) => setScriptText(e.target.value)}
            />
          </div>
          <div className="tpl-side">
            <p className="tpl-cap">标准模板列（用「-」分隔）：</p>
            <div className="tpl-cols">
              <span>序号</span> - <span>角色</span> - <span>情绪</span> - <span>台词</span>
            </div>
            <p className="tpl-note">
              （xlsx 模板按列填写：序号 / 角色 / 情绪 / 台词，无需分隔符）
            </p>
            <button className="btn btn-secondary btn-sm" onClick={handleLoadSample}>
              粘贴示例台本
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleDownloadTemplate}>
              ⬇ 下载标准模板
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleDownloadXlsxTemplate}>
              ⬇ 下载 xlsx 模板
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleParse}>
              解析台本
            </button>
          </div>
        </div>
      </section>

      {/* ② 批量配音 */}
      <section className="panel">
        <h2 className="panel-title">
          <span className="idx">②</span>批量配音
        </h2>
        <div className="dub-bar">
          <button className="btn btn-primary" onClick={runBatch} disabled={dubbing}>
            ▶ 开始配音
          </button>
          <button className="btn btn-secondary" onClick={togglePause} disabled={!dubbing}>
            {paused ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button className="btn btn-secondary" onClick={cancelBatch} disabled={!dubbing}>
            ✕ 取消
          </button>
          <div className="total-progress">
            <div className="pbar">
              <i style={{ width: `${totalPct}%` }} />
            </div>
            <div className="pcount">{totalText}</div>
          </div>
          <ComboBox
            mini
            ariaLabel="批量改音色"
            options={voiceOptions}
            value={null}
            placeholder="批量改音色…"
            search
            onChange={(v) => applyBatchVoice(v)}
          />
        </div>
      </section>

      {/* ③ 台词表 */}
      <section className="panel">
        <h2 className="panel-title">
          <span className="idx">③</span>台词表
          <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 13 }}>
            {rows.length ? `共 ${rows.length} 行` : ''}
          </span>
        </h2>
        <div className="table-wrap">
          <table className="tb">
            <thead>
              <tr>
                <th style={{ width: 48 }}>序号</th>
                <th style={{ width: 120 }}>角色</th>
                <th style={{ width: 90 }}>情绪</th>
                <th>台词（预览）</th>
                <th style={{ width: 200 }}>关联音色</th>
                <th style={{ width: 110 }}>状态</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={7}>还没有台本，先粘贴并解析台词表（① 上传区）</td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={r.index} className={sheetRowIndex === i && sheetOpen ? 'sel' : ''}>
                    <td className="cell-idx" data-label="序号">
                      {r.index}
                    </td>
                    <td data-label="角色">
                      <b style={{ color: 'var(--text-strong)' }}>{r.role}</b>
                    </td>
                    <td className="cell-emo" data-label="情绪">
                      {r.emotion}
                    </td>
                    <td data-label="台词">
                      <div className="cell-line" title={r.text}>
                        {r.text}
                      </div>
                    </td>
                    <td data-label="关联音色">
                      <ComboBox
                        mini
                        ariaLabel="关联音色"
                        options={voiceOptions}
                        value={r.voiceId}
                        placeholder="选择音色…"
                        search
                        onChange={(v) => onRowVoice(i, v)}
                      />
                    </td>
                    <td data-label="状态">{renderStatus(r)}</td>
                    <td data-label="操作">
                      <div className="row-actions">
                        <button
                          className="icon-btn"
                          title="试听"
                          aria-label="试听"
                          disabled={!r.wavBlob}
                          onClick={() => openSheet(i, 'preview')}
                        >
                          🔊
                        </button>
                        <button
                          className="icon-btn"
                          title={r.wavBlob ? '重新生成' : '开始配音'}
                          aria-label={r.wavBlob ? '重新生成' : '开始配音'}
                          onClick={() => openSheet(i, 'regen')}
                        >
                          ⟳
                        </button>
                        <button
                          className="icon-btn"
                          title="下载"
                          aria-label="下载"
                          disabled={!r.wavBlob}
                          onClick={() => downloadRow(r)}
                        >
                          ⬇
                        </button>
                        <button
                          className="icon-btn"
                          title="删除"
                          aria-label="删除"
                          onClick={() => deleteRow(i)}
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ④ 批量下载 */}
      <section className="panel">
        <h2 className="panel-title">
          <span className="idx">④</span>批量下载
        </h2>
        <div className="rule-bar">
          <span className="r-ico" aria-hidden="true">ℹ</span>
          <div className="r-txt">
            命名规则：<code>序号.角色.情绪.台词概略.wav</code>，其中「台词概略」= 去标点、截断约 12 字。
            <span className="ex">
              示例：<b>1.旁白.平静.在很久很久以前云雾.wav</b> &nbsp;·&nbsp;{' '}
              <b>4.反派陈boss.愤怒.这座城市从今往后只.wav</b>
            </span>
          </div>
        </div>

        <div className={`banner${zipBannerShow ? ' show' : ''}`} style={{ background: 'var(--color-info-surface)', color: 'var(--color-info)' }}>
          <span aria-hidden="true">📦</span>
          <span>整包体积较大，确认打包下载？（已选 {selectedNames.size || doneRows.length} 个文件）</span>
          <div className="b-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setZipBannerShow(false)}>
              取消
            </button>
            <button className="btn btn-primary btn-sm" onClick={doZip}>
              确认下载
            </button>
          </div>
        </div>

        {doneRows.length > 0 && (
          <div className="list-tools">
            <span className="lt-label">按角色筛选</span>
            <ComboBox
              mini
              ariaLabel="按角色筛选"
              options={roleOptions.map((r) => ({ value: r, label: r }))}
              value={roleFilter ?? '全部角色'}
              placeholder="全部角色"
              onChange={(v) => setRoleFilter(v === '全部角色' ? null : v)}
            />
            <span className="lt-label" style={{ marginLeft: 'auto' }}>
              已生成 {doneRows.length} 个可下载音频
            </span>
          </div>
        )}

        {doneRows.length > 0 ? (
          <>
            <div className="file-list">
              {fileListRows.map((r) => {
                const name = fileNameOf(r);
                const sel = selectedNames.has(name);
                return (
                  <div
                    key={name}
                    className={`file-row${sel ? ' sel' : ''}`}
                    onClick={() => toggleSelect(name)}
                  >
                    <span
                      className={`cbox${sel ? ' on' : ''}`}
                      role="checkbox"
                      aria-checked={sel}
                      aria-label={`选择 ${name}`}
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(name);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleSelect(name);
                        }
                      }}
                    >
                      <svg viewBox="0 0 12 12">
                        <path d="M2.5 6l2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="fname" title={name}>
                      {name}
                      <span className="ext">.wav</span>
                    </span>
                    <span className="chip">{r.role}</span>
                    <span className="fdur">{formatDur(r.durationSec)}</span>
                    <button
                      className="dl-one"
                      title="下载该文件"
                      aria-label={`下载 ${name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadRow(r);
                      }}
                    >
                      ⬇
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="action-bar">
              <div className="ab-left">
                <span
                  className={`cbox${selectedNames.size === fileListRows.length && fileListRows.length > 0 ? ' on' : ''}`}
                  role="checkbox"
                  aria-checked={selectedNames.size === fileListRows.length && fileListRows.length > 0}
                  aria-label="全选"
                  tabIndex={0}
                  onClick={toggleSelectAll}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      toggleSelectAll();
                    }
                  }}
                >
                  <svg viewBox="0 0 12 12">
                    <path d="M2.5 6l2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="sel-count">
                  已选 <b>{selectedNames.size}</b> / {fileListRows.length} 个文件
                </span>
              </div>
              <div className="ab-right">
                <button className="btn btn-secondary" onClick={handleDownloadZip}>
                  🗜 下载为 ZIP
                </button>
                <button className="btn btn-primary" onClick={handleDownloadAll}>
                  ⬇ 下载全部
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty">
            <div className="e-ico" aria-hidden="true">📭</div>
            <h2>还没有已合成音频</h2>
            <p>先完成「批量配音」，生成结果会出现在这里供你下载。</p>
          </div>
        )}
      </section>

      {/* 试听底部面板 */}
      <div className={`sheet-mask${sheetOpen ? ' show' : ''}`} onClick={() => isMobile() && closeSheet()} />
      <aside className={`preview-sheet${sheetOpen ? ' open' : ''}`} aria-label="试听面板">
        <div className="ps-handle" aria-hidden="true" />
        <div className="ps-top">
          <div className="ps-who">
            <div className="av" aria-hidden="true">
              {sheetRow?.voiceId ? '🔊' : '⚠'}
            </div>
            <div>
              <div className="nm">{sheetRow?.voiceName || '未关联音色'}</div>
              <div className="rl">
                {sheetRow ? `角色：${sheetRow.role} · 第 ${sheetRow.index} 行` : '选择一行试听'}
              </div>
            </div>
          </div>
          <button className="ps-close" aria-label="关闭试听面板" onClick={closeSheet}>
            ✕
          </button>
        </div>
        <div className="ps-body">
          <button className="play-btn" aria-label="播放/暂停" disabled={!previewUrl} onClick={togglePlay}>
            {playing ? '⏸' : '▶'}
          </button>
          <div className="wave" aria-hidden="true">
            {Array.from({ length: 64 }).map((_, k) => (
              <span
                key={k}
                className={`bar${(k / 64) * 100 <= audioProg ? ' done' : ''}`}
                style={{ height: `${10 + Math.abs(Math.sin(k * 0.5)) * 36 + 8}px` }}
              />
            ))}
          </div>
          <div className="ps-meta">
            <span>
              时长 <b>{formatDur(sheetRow?.durationSec)}</b>
            </span>
            <span>{previewUrl ? (playing ? '播放中…' : '就绪') : '未合成，请先配音'}</span>
          </div>
        </div>
        <div className="ps-progress">
          <div className="pbar">
            <i style={{ width: `${audioProg}%` }} />
          </div>
        </div>
        <audio
          ref={audioRef}
          src={previewUrl ?? undefined}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setAudioProg(0);
          }}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            if (a.duration) setAudioProg((a.currentTime / a.duration) * 100);
          }}
        />
        <audio ref={compareAudioRef} />

        {/* 重新生成表单 */}
        <div className={`ps-regen${sheetMode === 'regen' ? ' show' : ''}`}>
          <div className="regen-grid">
            <div className="field" style={{ margin: 0, minWidth: 170 }}>
              <label>关联音色</label>
              <ComboBox
                mini
                ariaLabel="重新生成音色"
                options={voiceOptions}
                value={regenVoiceId}
                placeholder="选择音色…"
                search
                onChange={(v) => setRegenVoiceId(v)}
              />
            </div>
            <div className="field" style={{ margin: 0, minWidth: 160 }}>
              <label>
                语速 <span style={{ color: 'var(--brand)', fontWeight: 700 }}>{regenSpeed.toFixed(1)}×</span>
              </label>
              <input
                className="slider"
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={regenSpeed}
                onChange={(e) => setRegenSpeed(Number(e.target.value))}
              />
            </div>
            <div className="field" style={{ margin: 0, minWidth: 200 }}>
              <label>情绪</label>
              <ComboBox
                mini
                ariaLabel="重新生成情绪"
                options={emotionOptions}
                value={regenEmotion}
                placeholder="选择情绪…"
                search
                onChange={(v) => setRegenEmotion(v)}
              />
            </div>
            <div className="field" style={{ margin: 0, flex: 1, minWidth: 240 }}>
              <label>风格描述（instruct）</label>
              <textarea
                value={regenInstruct}
                placeholder="例如：沉稳的男声，带着悲伤的情绪"
                style={{ minHeight: 56 }}
                onChange={(e) => setRegenInstruct(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-sm" style={{ marginBottom: 2 }} onClick={handleRegen}>
              ⟳ {sheetRow?.wavBlob ? '重新生成' : '开始配音'}
            </button>
          </div>
          <div className={`compare${showCompare ? ' show' : ''}`}>
            <span style={{ fontSize: 12, color: 'var(--text-soft)', fontWeight: 600 }}>与上一版对比：</span>
            <button className="ab prev" onClick={playPrev}>
              <span className="tag">上一版</span>
              <span>▶ 播放</span>
            </button>
            <button className="ab cur" onClick={playCur}>
              <span className="tag">当前版</span>
              <span>▶ 播放</span>
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
};

/** 是否为移动端（≤1024）：用于试听面板遮罩点击关闭 */
function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width:1024px)').matches;
}

export default DubbingTab;
