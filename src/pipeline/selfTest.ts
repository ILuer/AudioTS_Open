/**
 * selfTest.ts — 分片模型科学验证
 *
 * 独立测试每个 ONNX 模型，确认输出形状和合理性，
 * 无需依赖完整的合成管线。
 *
 * 从浏览器控制台调用: await window.__selftest() 或点击按钮
 */
import { OrtSessionManager } from '@/core/ortSessionManager';
import { Tokenizer } from './tokenizer';
import { OUTPUT_SAMPLE_RATE as SR } from '@/core/constants';

/** Python Pipeline.generate('Hello', do_sample=False) → 15 frames, 240 codes */
const REFERENCE_CODES_HELLO = [1995, 532, 1114, 1723, 32, 1393, 1631, 1095, 1629, 329, 1896, 1377, 6, 1529, 82, 1606, 215, 117, 1398, 1149, 285, 785, 77, 739, 993, 905, 1358, 903, 2003, 1860, 595, 1509, 294, 1382, 1108, 398, 1427, 827, 261, 678, 1819, 1767, 472, 791, 689, 1037, 510, 812, 1925, 1100, 344, 1366, 110, 1173, 1460, 289, 1835, 142, 651, 236, 591, 1619, 224, 82, 1029, 1022, 453, 67, 1288, 383, 1460, 485, 1976, 747, 125, 1241, 1887, 168, 1869, 949, 122, 1423, 1349, 1812, 1624, 638, 1460, 818, 782, 1632, 874, 1117, 1294, 1784, 166, 994, 508, 1464, 1765, 3, 1624, 1978, 1965, 202, 1819, 2001, 1297, 144, 309, 1869, 1955, 484, 1248, 1448, 687, 1623, 127, 1113, 1460, 119, 1558, 65, 1509, 617, 1853, 93, 1223, 63, 1119, 1208, 1718, 1829, 678, 284, 400, 1839, 220, 149, 473, 1374, 981, 1509, 1818, 211, 1792, 1449, 1756, 926, 1591, 673, 902, 1095, 1299, 331, 334, 1961, 159, 1359, 805, 1426, 167, 230, 877, 156, 845, 1113, 1336, 1690, 118, 1501, 129, 429, 1056, 923, 1940, 1898, 1375, 853, 587, 1887, 1872, 730, 474, 2024, 362, 96, 1470, 1565, 1091, 1934, 1755, 944, 424, 2044, 826, 349, 1570, 1310, 274, 566, 1789, 1492, 1358, 362, 1532, 1422, 269, 2020, 892, 1782, 375, 1693, 1605, 915, 576, 580, 1694, 905, 1241, 903, 1452, 781, 1008, 1668, 1431, 614, 1600, 494, 1027, 121, 378, 1617, 993, 526, 1519, 1689, 390, 217, 543, 1458];

const H = 2048;
const V = 2048;
const N_GROUPS = 16;
const DEC_FRAMES = 25;

/** 测试结果 */
interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
  timingMs: number;
}

/** 验证 Float32Array 范围是否在预期内 */
function checkRange(expected: number, actual: number, tolerance: number = 0.01): boolean {
  return Math.abs(expected - actual) / (Math.abs(expected) + 1e-8) < tolerance;
}

/** 检查数组中是否有非零值（证明模型输出了有意义信号） */
function hasSignal(arr: Float32Array, threshold = 1e-6): boolean {
  for (let i = 0; i < Math.min(arr.length, 100); i++) {
    if (Math.abs(arr[i]) > threshold) return true;
  }
  return false;
}

export async function runSelfTest(
  sm: OrtSessionManager,
  tokenizer?: Tokenizer,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const t0 = performance.now();

  // ═══════════════════════════════════════════
  // Test 1: text_embed.onnx
  // ═══════════════════════════════════════════
  try {
    const t1 = performance.now();
    const testIds = new Int32Array([0, 1, 2]); // 3 trivial token IDs
    const res = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'text_embed',
      { text_ids: testIds },
      { text_ids: [1, 3] },
      'selftest',
    );
    const emb = new Float32Array(res.data!['text_embeds'] ?? res.data![Object.keys(res.data!)[0]]);
    const expectedLen = 3 * H; // 6144
    const hasSig = hasSignal(emb);
    results.push({
      name: 'text_embed.onnx',
      pass: emb.length === expectedLen && hasSig,
      detail: `shape=[1,3,${H}] len=${emb.length} (expected ${expectedLen}) hasSignal=${hasSig}`,
      timingMs: performance.now() - t1,
    });
  } catch (e: any) {
    results.push({ name: 'text_embed.onnx', pass: false, detail: `ERROR: ${e?.message || e}`, timingMs: 0 });
  }

  // ═══════════════════════════════════════════
  // Test 2: codec_embed.onnx
  // ═══════════════════════════════════════════
  try {
    const t1 = performance.now();
    const testIds = new Int32Array([0, 2047]); // CODEC_PAD + CODEC_BOS
    const res = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'codec_embed',
      { codec_ids: testIds },
      { codec_ids: [1, 2] },
      'selftest',
    );
    const emb = new Float32Array(res.data!['codec_embeds'] ?? res.data![Object.keys(res.data!)[0]]);
    const expectedLen = 2 * H;
    const hasSig = hasSignal(emb);
    results.push({
      name: 'codec_embed.onnx',
      pass: emb.length === expectedLen,
      detail: `shape=[1,2,${H}] len=${emb.length} (expected ${expectedLen}) hasSignal=${hasSig}`,
      timingMs: performance.now() - t1,
    });
  } catch (e: any) {
    results.push({ name: 'codec_embed.onnx', pass: false, detail: `ERROR: ${e?.message || e}`, timingMs: 0 });
  }

  // ═══════════════════════════════════════════
  // Test 3: talker.onnx (small non-zero input)
  // ═══════════════════════════════════════════
  try {
    const t1 = performance.now();
    // 创建 3 个 token 的小随机输入 (非零，验证模型能处理有意义的输入)
    const smallIn = new Float32Array(3 * H);
    // 填充非零小值
    for (let i = 0; i < smallIn.length; i++) {
      smallIn[i] = (i % 1000) / 10000; // small non-zero values
    }
    const pos = new Int32Array(9); // [3,1,3] → 3*3 = 9
    for (let a = 0; a < 3; a++) for (let i = 0; i < 3; i++) pos[a * 3 + i] = i;
    const mask = new Int32Array(3); mask.fill(1);

    const res = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'talker',
      { inputs_embeds: smallIn, position_ids: pos, attention_mask: mask },
      { inputs_embeds: [1, 3, H], position_ids: [3, 1, 3], attention_mask: [1, 3] },
      'selftest',
    );
    const keys = Object.keys(res.data!);
    const logits = new Float32Array(res.data!['logits'] ?? res.data![keys[0]]);
    const hidden = new Float32Array(res.data!['hidden_states'] ?? res.data![keys[1]]);
    const expectedLogitsLen = 3 * V;
    const expectedHiddenLen = 3 * H;
    const hasSig = hasSignal(logits);

    // 第3个 token 的 first-codebook logits (位置 2*V)
    const lastLogits = new Float32Array(V);
    for (let i = 0; i < V; i++) lastLogits[i] = logits[2 * V + i];
    const maxVal = Math.max(...Array.from(lastLogits.slice(0, 20)));

    results.push({
      name: 'talker.onnx',
      pass: logits.length === expectedLogitsLen && hidden.length === expectedHiddenLen && hasSig,
      detail: `logits=${logits.length}/${expectedLogitsLen} hidden=${hidden.length}/${expectedHiddenLen} hasSignal=${hasSig} keys=[${keys.join(',')}] max(last20logits)=${maxVal.toFixed(2)}`,
      timingMs: performance.now() - t1,
    });
  } catch (e: any) {
    results.push({ name: 'talker.onnx', pass: false, detail: `ERROR: ${e?.message || e}`, timingMs: 0 });
  }

  // ═══════════════════════════════════════════
  // Test 4: code_predictor.onnx
  // ═══════════════════════════════════════════
  try {
    const t1 = performance.now();
    const th = new Float32Array(H);
    for (let i = 0; i < H; i++) th[i] = (i % 1000) / 10000;
    const cIds = new Int32Array(N_GROUPS);
    for (let i = 0; i < N_GROUPS; i++) cIds[i] = i * 100;
    const res = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'code_predictor',
      { talker_hidden: th, codec_ids: cIds },
      { talker_hidden: [1, H], codec_ids: [1, N_GROUPS] },
      'selftest',
    );
    const gl = new Float32Array(res.data!['group_logits'] ?? res.data![Object.keys(res.data!)[0]]);
    const expectedLen = (N_GROUPS - 1) * V;
    const hasSig = hasSignal(gl);
    results.push({
      name: 'code_predictor.onnx',
      pass: gl.length === expectedLen && hasSig,
      detail: `group_logits=${gl.length}/${expectedLen} (15 groups × ${V} vocab) hasSignal=${hasSig}`,
      timingMs: performance.now() - t1,
    });
  } catch (e: any) {
    results.push({ name: 'code_predictor.onnx', pass: false, detail: `ERROR: ${e?.message || e}`, timingMs: 0 });
  }

  // ═══════════════════════════════════════════
  // Test 5: residual_embed.onnx
  // ═══════════════════════════════════════════
  try {
    const t1 = performance.now();
    const cIds = new Int32Array(N_GROUPS);
    for (let i = 0; i < N_GROUPS; i++) cIds[i] = i * 100;
    const res = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'residual_embed',
      { codec_ids: cIds },
      { codec_ids: [1, N_GROUPS] },
      'selftest',
    );
    const se = new Float32Array(res.data!['step_embed'] ?? res.data![Object.keys(res.data!)[0]]);
    const expectedLen = H;
    const hasSig = hasSignal(se);
    results.push({
      name: 'residual_embed.onnx',
      pass: se.length === expectedLen && hasSig,
      detail: `step_embed=${se.length}/${expectedLen} hasSignal=${hasSig}`,
      timingMs: performance.now() - t1,
    });
  } catch (e: any) {
    results.push({ name: 'residual_embed.onnx', pass: false, detail: `ERROR: ${e?.message || e}`, timingMs: 0 });
  }

  // ═══════════════════════════════════════════
  // Test 6: tok_decoder.onnx
  // ═══════════════════════════════════════════
  try {
    const t1 = performance.now();
    const codes = new Int32Array(DEC_FRAMES * N_GROUPS);
    for (let f = 0; f < DEC_FRAMES; f++)
      for (let g = 0; g < N_GROUPS; g++)
        codes[f * N_GROUPS + g] = 100;

    const res = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'tok_decoder',
      { audio_codes: codes },
      { audio_codes: [1, DEC_FRAMES, N_GROUPS] },
      'selftest',
    );
    const wav = new Float32Array(res.data!['waveform'] ?? res.data![Object.keys(res.data!)[0]]);
    const hasSig = hasSignal(wav);
    // tok_decoder produces 600 samples per 25 frames at 12Hz
    const expectedMin = 500;
    results.push({
      name: 'tok_decoder.onnx',
      pass: wav.length >= expectedMin && hasSig,
      detail: `waveform=${wav.length}samples (≥${expectedMin}) hasSignal=${hasSig}`,
      timingMs: performance.now() - t1,
    });
  } catch (e: any) {
    results.push({ name: 'tok_decoder.onnx', pass: false, detail: `ERROR: ${e?.message || e}`, timingMs: 0 });
  }

  // ═══════════════════════════════════════════
  // Test 7: 小型端到端 (text_embed → talker)
  // ═══════════════════════════════════════════
  try {
    const t1 = performance.now();
    const bodyIds = new Int32Array([14990]); // "Hello" token
    const bodyEmb = await new Promise<Float32Array>(async (resolve) => {
      const r = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
        'text_embed', { text_ids: bodyIds }, { text_ids: [1, 1] }, 'selftest');
      resolve(new Float32Array(r.data!['text_embeds'] ?? r.data![Object.keys(r.data!)[0]]));
    });

    // 构造最小 prefill: role(3) + pad_block(4) + body(1+eos) + block2(1) = 9 tokens
    const specIds = new Int32Array([151644, 151645, 151643]); // <|im_start|>, <|im_end|>, <|endoftext|>
    const specR = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'text_embed', { text_ids: specIds }, { text_ids: [1, 3] }, 'selftest');
    const spec = new Float32Array(specR.data!['text_embeds'] ?? specR.data![Object.keys(specR.data!)[0]]);
    const padE = spec.slice(2 * H, 3 * H);
    const bosE = spec.slice(0, H);
    const eosE = spec.slice(H, 2 * H);

    // 用 padE 填充 9 个 token 构造 talker_in
    const T = 9;
    const testTalkerIn = new Float32Array(T * H);
    for (let t = 0; t < T; t++) {
      for (let j = 0; j < H; j++) {
        testTalkerIn[t * H + j] = bodyEmb[j % bodyEmb.length]; // use body embedding everywhere
      }
    }

    const tpos = new Int32Array(3 * T);
    for (let a = 0; a < 3; a++) for (let i = 0; i < T; i++) tpos[a * T + i] = i;
    const tmask = new Int32Array(T); tmask.fill(1);

    const tRes = await sm.runInference<{ success: boolean; data: Record<string, ArrayBuffer> }>(
      'talker', { inputs_embeds: testTalkerIn, position_ids: tpos, attention_mask: tmask },
      { inputs_embeds: [1, T, H], position_ids: [3, 1, T], attention_mask: [1, T] }, 'selftest');
    const tk = Object.keys(tRes.data!);
    const tlogits = new Float32Array(tRes.data!['logits'] ?? tRes.data![tk[0]]);
    const lastVocab = new Float32Array(V);
    for (let i = 0; i < V; i++) lastVocab[i] = tlogits[(T - 1) * V + i];
    const top5v: { id: number; v: number }[] = [];
    for (let i = 0; i < V; i++) top5v.push({ id: i, v: lastVocab[i] });
    top5v.sort((a, b) => b.v - a.v);

    results.push({
      name: 'mini_e2e (embed→talker)',
      pass: hasSignal(tlogits),
      detail: `T=${T} logits=${tlogits.length} top5=${top5v.slice(0, 5).map(x => `${x.id}:${x.v.toFixed(2)}`)}`,
      timingMs: performance.now() - t1,
    });
  } catch (e: any) {
    results.push({ name: 'mini_e2e', pass: false, detail: `ERROR: ${e?.message || e}`, timingMs: 0 });
  }

  const totalMs = performance.now() - t0;
  for (const r of results) {
  }
  return results;
}

/** 用 Python 参考 codes 通过 TS tok_decoder 解码，验证音频链路 */
export async function decodeReferenceCodes(sm: OrtSessionManager): Promise<Float32Array> {
  const codes = new Int32Array(REFERENCE_CODES_HELLO);
  const totalFrames = codes.length / 16;

  // Same decode logic as TtsPipelineV2.decodeChunked
  const DEC_FRAMES = 25;
  const parts: Float32Array[] = [];

  for (let s = 0; s < totalFrames; s += DEC_FRAMES) {
    const remaining = totalFrames - s;
    const chunkLen = Math.min(DEC_FRAMES, remaining);
    const chunk = new Int32Array(DEC_FRAMES * 16);

    if (remaining >= DEC_FRAMES) {
      for (let f = 0; f < DEC_FRAMES; f++)
        for (let g = 0; g < 16; g++) chunk[f * 16 + g] = codes[(s + f) * 16 + g];
    } else {
      for (let f = 0; f < chunkLen; f++)
        for (let g = 0; g < 16; g++) chunk[f * 16 + g] = codes[(s + f) * 16 + g];
      for (let f = chunkLen; f < DEC_FRAMES; f++)
        for (let g = 0; g < 16; g++) chunk[f * 16 + g] = 0;
    }

    const res = await sm.runInference<{success:boolean;data:Record<string,ArrayBuffer>}>(
      'tok_decoder',
      { audio_codes: chunk },
      { audio_codes: [1, DEC_FRAMES, 16] },
      'decode_ref',
    );
    const wav = new Float32Array(res.data!['waveform'] ?? Object.values(res.data!)[0]);

    if (remaining >= DEC_FRAMES) {
      parts.push(wav);
    } else {
      parts.push(wav.slice(0, chunkLen * 1920)); // tok_decoder: 1920 samples/frame (48000/25)
    }
  }

  // Concatenate all parts
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const pcm = new Float32Array(totalLen);
  let off = 0;
  for (const p of parts) { pcm.set(p, off); off += p.length; }

  // Int16 WAV 下载（浏览器兼容性最好）
  const int16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  }
  const wavBuf = new ArrayBuffer(44 + int16.length * 2);
  const v = new DataView(wavBuf);
  const ws = (s: string, o: number) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws('RIFF', 0); v.setUint32(4, 36 + int16.length * 2, true); ws('WAVE', 8);
  ws('fmt ', 12); v.setUint32(16, 16, true); v.setUint16(20, 1, true); // 1=PCM
  v.setUint16(22, 1, true); v.setUint32(24, 24000, true);
  v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws('data', 36); v.setUint32(40, int16.length * 2, true);
  new Int16Array(wavBuf, 44, int16.length).set(int16);

  const blob = new Blob([wavBuf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'ref_hello.wav';
  a.textContent = '点击下载 ref_hello.wav'; a.style.cssText = 'position:fixed;top:20px;left:20px;z-index:99999;background:#4caf50;color:white;padding:10px 20px;font-size:16px;text-decoration:none;border-radius:4px';
  document.body.appendChild(a);

  // 同时尝试播放
  try {
    const audio = new Audio(url);
    audio.play().catch(() => {});
  } catch {}

  return pcm;
}
