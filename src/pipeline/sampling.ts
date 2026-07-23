/**
 * src/pipeline/sampling.ts — 采样算法（忠实移植 Python inference.py）
 *
 * 目标 1（参数全可视化且真正生效）的推理核心基础。本文件提供：
 *   - makeRng(seed)：带种子的 PRNG（mulberry32），近似 Python np.random.default_rng
 *   - buildSuppressMask(...)：codec 特殊 token 抑制掩码（保留 codec_eos）
 *   - applyRepetitionPenalty(...)：对历史 token 降权
 *   - sampleToken(...)：argmax / top_k / top_p / temperature 多项式采样
 *
 * 注：Python 使用 PCG64，本实现用 mulberry32，分布近似但非逐位一致（注释标明）。
 * AR 循环消费这些函数让采样参数真正生效（详见 arLoopRunner，本轮 AR 算法重写待跟进）。
 */

/**
 * 带种量的伪随机数生成器（mulberry32）。
 * 返回 [0,1) 区间的浮点数。与 Python np.random.default_rng(seed) 的 PCG64
 * 分布近似但非逐位一致——同 seed 可复现本实现自身的序列，但不等于 Python 的序列。
 */
export function makeRng(seed: number): () => number {
  // Hash seed via SplitMix32 to ensure uniform state distribution
  // regardless of seed magnitude. Fixes seed=0 perfect / seed≠0 jitter bug.
  let z = (seed + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z = (z ^ (z >>> 16)) >>> 0;

  let a = z;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 构建 codec 特殊 token 抑制掩码。
 * 把 [suppressStart, vocabSize) 范围内除 codecEosId 外的位置置为 -Infinity，
 * 其余位置置为 0（与原始 logits 相加后，被抑制位置变为 -Inf，codec_eos 保留）。
 *
 * 对应 Python `suppress = list(range(vocab-1024, vocab))` 并保留 codec_eos_token_id。
 */
export function buildSuppressMask(
  vocabSize: number,
  codecEosId: number,
  suppressStart: number,
): Float32Array {
  const mask = new Float32Array(vocabSize);
  for (let i = 0; i < vocabSize; i++) {
    if (i >= suppressStart && i < vocabSize && i !== codecEosId) {
      mask[i] = -Infinity;
    } else {
      mask[i] = 0;
    }
  }
  return mask;
}

/**
 * 重复惩罚：对 prevIds 中去重后的 token，正 logit 除以 penalty、负 logit 乘以 penalty。
 * 忠实对齐 Python inference.py `_apply_repetition_penalty`：
 *   - 先用 set() 去重（避免多次惩罚同一个 token）
 *   - 正数用除、负数用乘（保持符号，放大惩罚效果）
 * 返回新数组，不改原 logits。
 */
export function applyRepetitionPenalty(
  logits: Float32Array,
  prevIds: number[],
  penalty: number,
): Float32Array {
  if (!prevIds.length || penalty === 1) return logits;
  const out = new Float32Array(logits);
  // 去重后对每个唯一 token 分别惩罚（对齐 Python set 去重）
  const uniqueIds = [...new Set(prevIds)];
  for (const id of uniqueIds) {
    if (id >= 0 && id < out.length) {
      if (out[id] > 0) {
        out[id] /= penalty;
      } else {
        // 负 logit 乘 penalty → 更负，对齐 Python np.where(sc < 0, sc * penalty, sc / penalty)
        out[id] *= penalty;
      }
    }
  }
  return out;
}

export interface SampleOptions {
  doSample: boolean;
  topK: number;
  topP: number;
  temperature: number;
  rng: () => number;
  /** Token IDs that bypass top_k filtering (e.g., EOS) — always kept in candidate pool */
  protectedTokens?: number[];
}

/**
 * 采样单个 token，忠实移植 Python inference.py `_sample`：
 *   - do_sample=false 或 temperature<=0 → argmax（贪婪）
 *   - 否则：logits / temperature → top_k 截断 → top_p 核采样 → 多项式采样
 *
 * top_k=0 表示不截断；top_p>=1 表示不截断。
 */
export function sampleToken(logits: Float32Array, opts: SampleOptions): number {
  const { doSample, topK, topP, temperature, rng } = opts;

  // 贪婪：关闭采样或温度非正
  if (!doSample || temperature <= 0) {
    let best = 0;
    let bestVal = logits[0];
    for (let i = 1; i < logits.length; i++) {
      if (logits[i] > bestVal) {
        bestVal = logits[i];
        best = i;
      }
    }
    return best;
  }

  // 1. 温度缩放（拷贝）
  const scaled = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i] / temperature;
    scaled[i] = Number.isFinite(v) ? v : -Infinity;
  }

  // 2. top_k 截断：仅保留最高的 k 个，其余置 -Inf
  //    protected tokens (e.g., EOS) bypass top_k filtering — always kept
  let working = scaled;
  if (topK > 0 && topK < scaled.length) {
    const protectedSet = new Set(opts.protectedTokens ?? []);
    const idx = Array.from({ length: scaled.length }, (_, i) => i);
    idx.sort((a, b) => scaled[b] - scaled[a]);
    const keep = new Set(idx.slice(0, topK));
    // Ensure protected tokens are always included
    for (const pid of protectedSet) {
      if (pid >= 0 && pid < scaled.length) keep.add(pid);
    }
    working = new Float32Array(scaled.length);
    for (let i = 0; i < scaled.length; i++) {
      working[i] = keep.has(i) ? scaled[i] : -Infinity;
    }
  }

  // 3. top_p 核采样：按概率从高到低累加，截断超过 top_p 的尾部
  //    先 softmax 得概率
  const probs = softmax(working);
  const order = Array.from({ length: probs.length }, (_, i) => i);
  order.sort((a, b) => probs[b] - probs[a]);

  let cum = 0;
  const nucleusMask = new Uint8Array(probs.length);
  for (let k = 0; k < order.length; k++) {
    const id = order[k];
    nucleusMask[id] = 1;
    cum += probs[id];
    if (cum >= topP) break;
  }

  // 重归一化
  let mass = 0;
  for (let i = 0; i < probs.length; i++) if (nucleusMask[i]) mass += probs[i];
  if (mass <= 0) return order[0];

  // 4. 多项式采样
  const r = rng() * mass;
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    if (!nucleusMask[i]) continue;
    acc += probs[i];
    if (r <= acc) return i;
  }
  // 兜底：返回核内最后一个
  for (let k = order.length - 1; k >= 0; k--) {
    if (nucleusMask[order[k]]) return order[k];
  }
  return order[0];
}

/** 数值稳定的 softmax（-Inf 项贡献 0）。 */
function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i];
  }
  if (!Number.isFinite(max)) {
    // 全 -Inf：均匀分布兜底
    const u = new Float32Array(logits.length).fill(1 / logits.length);
    return u;
  }
  const exps = new Float32Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - max);
    exps[i] = e;
    sum += e;
  }
  if (sum <= 0) {
    return new Float32Array(logits.length).fill(1 / logits.length);
  }
  for (let i = 0; i < logits.length; i++) exps[i] /= sum;
  return exps;
}
