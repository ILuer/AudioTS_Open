/**
 * BPE (Byte-Pair Encoding) 分词器
 * ================================
 * 改进依据: 反思报告 P0-4 — Tokenizer实现方案需明确文档化
 * 
 * 实现来源:
 *   - 对齐 Qwen2Tokenizer 行为（HuggingFace transformers 库）
 *   - 使用三个外部文件: vocab.json, merges.txt, tokenizer_config.json
 *   - 加载路径: Models/voicedesign/onnx/bpe/
 * 
 * 分词流程:
 *   1. 扫描 added_tokens（如 <|im_start|>, <|im_end|>）→ 注入对应 ID
 *   2. 普通文本: lowercase + NFKC 标准化
 *   3. Qwen2 预分词正则: (?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
 *   4. Byte 编码 → BPE merge → vocab 查表
 * 
 * <|im_start|> (151644) / <|im_end|> (151645) 作为 added_tokens，
 * 由 encode() 自动识别并注入对应 ID，不再需要调用方手动注入。
 * 
 * 已知局限（反思报告 P0-4）:
 *   - 非 Qwen2 原生 tokenizer 实现（未使用 HuggingFace tokenizers WASM 绑定）
 *   - <|im_start|>, <|im_end|>, <|audio_start|>, <|audio_end|> 等特殊 token
 *     的保真度有限（作为 added_tokens 匹配，可能与原生 tokenizer 不完全一致）
 *   - M0 建议: 与 Python 端 tokenizer 输出做交叉验证，确保 token ID 序列对齐
 * 
 * 待优化:
 *   - 性能: 考虑使用 HuggingFace tokenizers WASM 绑定（反思报告 P0-4）
 *   - 内存: 预加载 vocab 缓存以减少首次编码延迟
 *   - 校验: 添加 token ID 范围检查（防止无效 token 导致 ONNX 推理失败）
 */

import { AppError } from '@/types';

/** added_tokens_decoder 中的单个 token 配置 */
export interface AddedTokenConfig {
  /** token 字符串内容 */
  content: string;
  /** 是否经过规范化（lowercase + NFKC），false 表示不规范化 */
  normalized?: boolean;
  /** 是否为特殊 token */
  special?: boolean;
  /** 单 token 或 token 片段 */
  single_word?: boolean;
  /** 左/右 strip 配置 */
  lstrip?: boolean;
  rstrip?: boolean;
}

/** Qwen2 pre-tokenization 正则（来源：HuggingFace transformers Qwen2Tokenizer） */
const QWEN2_PRE_TOKENIZE_PATTERN =
  /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

export class Tokenizer {
  /** vocab: word → token ID */
  private vocab: Map<string, number> = new Map();
  /** merges: pair → rank（rank 越小优先级越高） */
  private merges: Map<string, number> = new Map();
  /** reverse vocab: token ID → word */
  private reverseVocab: Map<number, string> = new Map();
  /** 是否已加载 */
  private loaded: boolean = false;

  /** add_prefix_space 配置（Qwen2: false） */
  private addPrefixSpace: boolean = true;

  /** added_tokens：special token 字符串 → ID（用于前置匹配） */
  private addedTokenContentToId: Map<string, number> = new Map();

  /** added_tokens：ID → 配置（含 normalized 等字段） */
  private addedTokens: Map<number, AddedTokenConfig> = new Map();

  /** GPT-2 byte-to-unicode 映射: 原始 byte (0-255) → Unicode 字符 */
  private byteToChar: Map<number, string> = new Map();

  /**
   * 从原始数据加载（无需 fetch URL——用于 webkitdirectory 直接读取本地文件）
   */
  loadFromData(vocabJson: string, mergesText: string, configJson?: string): void {
    const vocab = JSON.parse(vocabJson) as Record<string, number>;
    this.vocab.clear();
    this.reverseVocab.clear();
    for (const [word, id] of Object.entries(vocab)) {
      this.vocab.set(word, id);
      this.reverseVocab.set(id, word);
    }
    this.merges.clear();
    const lines = mergesText.split('\n');
    const startIndex = lines[0]?.startsWith('#') ? 1 : 0;
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length === 2) {
        this.merges.set(parts[0] + ' ' + parts[1], i - startIndex);
      }
    }
    if (configJson) {
      try {
        const cfg = JSON.parse(configJson) as Record<string, unknown>;
        if (typeof cfg['add_prefix_space'] === 'boolean') {
          this.addPrefixSpace = cfg['add_prefix_space'];
        }
        const decoder = cfg['added_tokens_decoder'] as Record<string, unknown> | undefined;
        if (decoder) {
          this.addedTokens.clear();
          this.addedTokenContentToId.clear();
          for (const [idStr, tokenCfg] of Object.entries(decoder)) {
            const id = parseInt(idStr, 10);
            const cfg = tokenCfg as Record<string, unknown>;
            this.addedTokens.set(id, {
              content: String(cfg.content ?? ''),
              normalized: Boolean(cfg.normalized),
              special: Boolean(cfg.special),
            });
            if (cfg.content) this.addedTokenContentToId.set(String(cfg.content), id);
          }
        }
      } catch { /* ignore config parse errors */ }
    }
    this.loaded = true;
  }

  /**
   * 加载 vocab.json、merges.txt 和可选的 tokenizer_config.json
   *
   * @param vocabUrl - vocab.json 的 URL
   * @param mergesUrl - merges.txt 的 URL
   * @param configUrl - tokenizer_config.json 的 URL（可选，用于 Qwen2 对齐）
   */
  async load(vocabUrl: string, mergesUrl: string, configUrl?: string): Promise<void> {
    try {
      const [vocabJson, mergesText] = await Promise.all([
        this.fetchJson<Record<string, number>>(vocabUrl),
        this.fetchText(mergesUrl),
      ]);

      this.vocab.clear();
      this.reverseVocab.clear();
      for (const [word, id] of Object.entries(vocabJson)) {
        this.vocab.set(word, id);
        this.reverseVocab.set(id, word);
      }

      this.merges.clear();
      const lines = mergesText.split('\n');
      const startIndex = lines[0]?.startsWith('#') ? 1 : 0;
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        if (parts.length === 2) {
          this.merges.set(parts[0] + ' ' + parts[1], i - startIndex);
        }
      }

      // 加载 tokenizer_config.json（Qwen2 特有配置）
      if (configUrl) {
        const cfg = await this.fetchJson<Record<string, unknown>>(configUrl);
        // add_prefix_space: Qwen2 为 false
        if (typeof cfg['add_prefix_space'] === 'boolean') {
          this.addPrefixSpace = cfg['add_prefix_space'];
        }

        // added_tokens_decoder: { "id": { content, normalized, special, ... } }
        const decoder = cfg['added_tokens_decoder'] as
          | Record<string, AddedTokenConfig>
          | undefined;
        if (decoder) {
          this.addedTokens.clear();
          this.addedTokenContentToId.clear();
          for (const [idStr, tokenCfg] of Object.entries(decoder)) {
            const id = parseInt(idStr, 10);
            this.addedTokens.set(id, tokenCfg);
            this.addedTokenContentToId.set(tokenCfg.content, id);
          }
        }
      }

      this.loaded = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError('BPE_LOAD_FAILED', `BPE 分词器加载失败: ${message}`);
    }
  }

  /**
   * 将文本编码为 token IDs。
   *
   * 流程：
   *   1. 前置扫描 added_tokens（normalized: false 的特殊 token）
   *   2. 对特殊 token 直接使用其预定义 ID
   *   3. 对普通文本段落：lowercase + NFKC → Qwen2 pre-tokenization → byte 编码 → BPE
   *
   * @param text - 待编码文本
   * @returns token ID 序列
   */
  encode(text: string): Int32Array {
    if (!this.loaded) {
      throw new AppError('BPE_NOT_LOADED', 'BPE 分词器尚未加载，请先调用 load()');
    }

    if (!text || text.length === 0) {
      return new Int32Array(0);
    }

    // Step 0: 扫描 added_tokens，按出现位置分割文本
    const result: number[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      let earliestIdx = remaining.length;
      let earliestToken = '';
      let earliestId = 0;

      for (const [tokenStr, id] of this.addedTokenContentToId) {
        const idx = remaining.indexOf(tokenStr);
        if (idx !== -1 && idx < earliestIdx) {
          earliestIdx = idx;
          earliestToken = tokenStr;
          earliestId = id;
        }
      }

      if (earliestIdx === remaining.length) {
        // 没有更多特殊 token → 剩余文本全部走 BPE 编码
        const bpeIds = this.bpeEncode(remaining);
        result.push(...bpeIds);
        break;
      }

      // 特殊 token 之前的普通文本 → BPE 编码
      if (earliestIdx > 0) {
        const before = remaining.substring(0, earliestIdx);
        const bpeIds = this.bpeEncode(before);
        result.push(...bpeIds);
      }

      // 特殊 token → 直接使用其 ID（normalized: false 不规范化）
      result.push(earliestId);
      remaining = remaining.substring(earliestIdx + earliestToken.length);
    }

    return new Int32Array(result);
  }

  /** 检查分词器是否已加载 */
  isLoaded(): boolean {
    return this.loaded;
  }

  // ── 私有方法 ──

  /**
   * 对普通文本执行 BPE 编码（不含 added_tokens）。
   *
   * 流程：
   *   1. lowercase + NFKC normalize
   *   2. Qwen2 pre-tokenization 正则切分
   *   3. 每个 word → byte 编码 → BPE merge → vocab 查表
   */
  private bpeEncode(text: string): number[] {
    if (!text || text.length === 0) return [];

    // Step 1: 规范化 — 小写 + Unicode NFKC
    let normalized = text.toLowerCase();
    try {
      normalized = normalized.normalize('NFKC');
    } catch {
      normalized = normalized.normalize('NFC');
    }

    // Step 2: Qwen2 pre-tokenization 正则切分
    const words = normalized.match(QWEN2_PRE_TOKENIZE_PATTERN) || [];

    // Step 3: 每个 word → byte 编码 → BPE → vocab lookup
    const result: number[] = [];
    for (const word of words) {
      const byteTokenStr = this.byteEncode(word);
      const bpeTokens = this.bpe(byteTokenStr);
      for (const bt of bpeTokens) {
        const id = this.vocab.get(bt);
        if (id !== undefined) {
          result.push(id);
        } else {
          // 未知 token → 逐字节回退
          const fallbackIds = this.encodeUnknown(bt);
          result.push(...fallbackIds);
        }
      }
    }

    return result;
  }

  /**
   * 构建 GPT-2 完整的 byte-to-unicode 映射表（256 字节 → Unicode 字符）。
   *
   * 对齐 HuggingFace GPT-2 `bytes_to_unicode()` 函数：
   *   - 可打印字节 (33-126, 161-172, 174-255) → 映射到自身
   *   - 其余 68 个非可打印字节 → 映射到 256+n 的 Unicode 码点
   *
   * 在首次调用 byteEncode 时懒初始化。
   */
  private buildByteMapping(): void {
    const bs: number[] = [];
    const cs: number[] = [];
    // 可打印字节：映射到自身
    for (let b = 33; b <= 126; b++) { bs.push(b); cs.push(b); }
    for (let b = 161; b <= 172; b++) { bs.push(b); cs.push(b); }
    for (let b = 174; b <= 255; b++) { bs.push(b); cs.push(b); }
    // 非可打印字节：映射到 256+
    let n = 0;
    for (let b = 0; b < 256; b++) {
      if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
    }
    // 构建查询表
    for (let i = 0; i < 256; i++) {
      const idx = bs.indexOf(i);
      this.byteToChar.set(i, String.fromCharCode(cs[idx]));
    }
  }

  /**
   * 将 word 转换为 byte-level 字符串表示（GPT-2 风格）。
   *
   * 每个 UTF-8 字节通过 `bytes_to_unicode()` 映射为 Unicode 字符：
   *   - 空格 (0x20) → Ġ (U+0120)
   *   - 换行 (0x0A) → Ċ (U+010A)
   *   - 制表 (0x09) → ĉ (U+0109)
   *   - 可打印 ASCII → 自身
   */
  private byteEncode(word: string): string {
    if (this.byteToChar.size === 0) this.buildByteMapping();
    const bytes = new TextEncoder().encode(word);
    return Array.from(bytes).map(b => this.byteToChar.get(b)!).join('');
  }

  /** BPE 核心算法：对 byte-level token 字符串应用 BPE merge */
  private bpe(token: string): string[] {
    if (token.length <= 1) return [token];

    let word: string[] = Array.from(token);

    while (word.length > 1) {
      let minRank = Infinity;
      let minIdx = -1;

      for (let i = 0; i < word.length - 1; i++) {
        const rank = this.merges.get(word[i] + ' ' + word[i + 1]);
        if (rank !== undefined && rank < minRank) {
          minRank = rank;
          minIdx = i;
        }
      }

      if (minIdx === -1) break;

      word = [
        ...word.slice(0, minIdx),
        word[minIdx] + word[minIdx + 1],
        ...word.slice(minIdx + 2),
      ];
    }

    return word;
  }

  /**
   * 处理未知 token 的回退策略。
   *
   * 在 byteEncode 正确实现 GPT-2 映射后，所有 BPE token 都应能在 vocab 中找到。
   * 此方法仅在 vocab/merges 文件损坏或版本不匹配时作为兜底。
   * 直接返回 <unk> token，不再尝试 <0x??> hex 格式（Qwen2 vocab 中不存在该格式）。
   */
  private encodeUnknown(_token: string): number[] {
    const unkId = this.vocab.get('<unk>');
    return unkId !== undefined ? [unkId] : [];
  }

  // ── 网络辅助 ──

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.text();
  }
}
