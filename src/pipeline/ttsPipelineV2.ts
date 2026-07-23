/**
 * ttsPipelineV2.ts — VoiceDesign TTS 纯前端推理管线
 *
 * 对标 Python inference.py Pipeline.generate()
 * - KV-cache talker (talker_cache.onnx) O(n) AR 循环
 * - VoiceDesign config.json token IDs（配置驱动，从 encodingRegistry 动态读取）
 * - tok_decoder 1920 samples/frame (48000/25)
 */
import { OrtSessionManager } from '@/core/ortSessionManager';
import {
  OUTPUT_SAMPLE_RATE as SR,
} from '@/core/constants';
import { encodingRegistry } from '@/core/encodingRegistry';
import { Tokenizer } from './tokenizer';
import { CodecEmbed } from './codecEmbed';
import { applyRepetitionPenalty, sampleToken, makeRng } from './sampling';
import { logger } from '@/core/logger';

// ── Architecture-fixed constants ──
const DEC_FRAMES = 25;      // tok_decoder fixed chunk size

// Minimum frames before allowing EOS — prevents word swallowing
// when sampling produces EOS too early in the AR loop
const MIN_FRAMES_BEFORE_EOS = 5;  // ~0.4s minimum audio duration

interface TtsInputV2 {
  text: string;
  language?: string;
  instruct?: string;
  seed?: number;
  speed?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  /** Progress callback: percent (0-100), stage description */
  onProgress?: (percent: number, message: string) => void;
}

export class TtsPipelineV2 {
  private sm: OrtSessionManager;
  private tokenizer: Tokenizer;
  private codecEmbed: CodecEmbed;

  constructor(sm: OrtSessionManager, tokenizer: Tokenizer) {
    this.sm = sm;
    this.tokenizer = tokenizer;
    this.codecEmbed = new CodecEmbed(sm);
  }

  async destroy(): Promise<void> {
    await this.sm.releaseAll();
  }

  // ── Embedding helpers ──

  private tokenize(text: string): Int32Array {
    return this.tokenizer.encode(text);
  }

  private async embedText(textIds: Int32Array): Promise<Float32Array> {
    const res = await this.sm.runInference<{success:boolean;data:Record<string,ArrayBuffer>}>(
      'text_embed',
      { text_ids: new Int32Array(textIds) },
      { text_ids: [1, textIds.length] },
      'embed',
    );
    const buf = res.data!['text_embeds'] ?? res.data![Object.keys(res.data!)[0]];
    return new Float32Array(buf);
  }

  private async embedCodec(codecIds: Int32Array): Promise<Float32Array> {
    return this.codecEmbed.embed(codecIds);
  }

  // ── KV-cache talker (Python _ar_loop_cached L407-447) ──

  private _pastNames: string[] | null = null;

  private getPastNames(count: number): string[] {
    if (this._pastNames) return this._pastNames;
    const names = ['past_kv', 'past_kv_0_1'];
    for (let i = 1; i < count / 2; i++) {
      names.push(`past_kv_${i}_0`, `past_kv_${i}_1`);
    }
    this._pastNames = names;
    return names;
  }

  private makeEmptyPast(): Float32Array[] {
    const past: Float32Array[] = [];
    const nPastTensors = encodingRegistry.getNumPastTensors();
    for (let i = 0; i < nPastTensors; i++) {
      past.push(new Float32Array(0));
    }
    return past;
  }

  private async talkerCacheStep(
    inputsEmbeds: Float32Array, positionIds: Int32Array, attentionMask: Int32Array,
    past: Float32Array[], pastLengths: Int32Array,
  ): Promise<{logits:Float32Array; hidden:Float32Array; present:Float32Array[]}> {
    const H = encodingRegistry.getTalkerHiddenSize();
    const nPastTensors = encodingRegistry.getNumPastTensors();
    const nKvHeads = encodingRegistry.getNumKvHeads();
    const headDim = encodingRegistry.getHeadDim();
    const seqLen = inputsEmbeds.length / H;
    const totalLen = attentionMask.length;
    const pastNames = this.getPastNames(nPastTensors);
    const feeds: Record<string, unknown> = {
      inputs_embeds: new Float32Array(inputsEmbeds),
      position_ids: new Int32Array(positionIds),
      attention_mask: new Int32Array(attentionMask),
    };
    const shapes: Record<string, number[]> = {
      inputs_embeds: [1, seqLen, H],
      position_ids: [3, 1, seqLen],
      attention_mask: [1, totalLen],
    };
    for (let i = 0; i < nPastTensors; i++) {
      feeds[pastNames[i]] = past[i];
      shapes[pastNames[i]] = [1, nKvHeads, pastLengths[i], headDim];
    }
    const res = await this.sm.runInference<{success:boolean;data:Record<string,ArrayBuffer>}>(
      'talker_cache', feeds, shapes, 'ar_loop_cached',
    );
    const keys = Object.keys(res.data!);
    const logitsBuf = res.data!['logits_Q4'] ?? res.data![keys[0]];
    const hiddenBuf = res.data!['hidden_states'] ?? res.data![keys[1]];
    const present: Float32Array[] = [];
    for (let i = 2; i < keys.length; i++) {
      present.push(new Float32Array(res.data![keys[i]]));
    }
    return {
      logits: new Float32Array(logitsBuf),
      hidden: new Float32Array(hiddenBuf),
      present,
    };
  }

  private async arLoopCached(
    talkerIn: Float32Array, trailing: Float32Array,
    _seed: number, rng: () => number,
    doSample: boolean, topK: number, topP: number, temperature: number,
    repetitionPenalty: number,
    subDoSample: boolean, subTemperature: number, subTopK: number, subTopP: number,
    maxFrames: number,
    onProgress?: (percent: number, message: string) => void,
  ): Promise<Int32Array[]> {
    const H = encodingRegistry.getTalkerHiddenSize();
    const V = encodingRegistry.getCodecVocabSize();
    const nPastTensors = encodingRegistry.getNumPastTensors();
    const nGroups = encodingRegistry.getNumCodeGroups();
    const suppressStart = encodingRegistry.getSuppressStart();
    const codecEos = encodingRegistry.getCodecEos();
    const cpVocab = encodingRegistry.getCodePredictorVocabSize();

    let past = this.makeEmptyPast();
    const pastLen = new Int32Array(nPastTensors);

    // Prefill
    const T0 = talkerIn.length / H;
    const pos0 = new Int32Array(3 * T0);
    for (let a = 0; a < 3; a++) for (let i = 0; i < T0; i++) pos0[a * T0 + i] = i;
    const mask0 = new Int32Array(T0); mask0.fill(1);

    let result = await this.talkerCacheStep(talkerIn, pos0, mask0, past, pastLen);
    let logits = result.logits; let hidden = result.hidden;
    past = result.present;
    for (let i = 0; i < nPastTensors; i++) pastLen[i] = T0;
    let total = T0;

    const allCodes: Int32Array[] = [];
    const prevFirst: number[] = [];

    // Decode loop
    for (let step = 0; step < maxFrames; step++) {
      // Report progress every 1% (500 frames / 90% ≈ 5.5 frames per percent)
      if (onProgress && step % 5 === 0) {
        const pct = Math.min(90, Math.round((step / maxFrames) * 90));
        onProgress(pct, `正在合成，请稍后。。。（${pct}%）`);
      }
      const first = new Float32Array(V);
      const baseOff = logits.length - V;
      for (let i = 0; i < V; i++) {
        let v = logits[baseOff + i];
        if (i >= suppressStart && i !== codecEos) v = -Infinity;
        first[i] = v;
      }
      const penalized = applyRepetitionPenalty(first, prevFirst, repetitionPenalty);
      const code0 = sampleToken(penalized, { doSample, topK, topP, temperature, rng, protectedTokens: [codecEos] });
      if (step >= MIN_FRAMES_BEFORE_EOS && code0 === codecEos) break;
      prevFirst.push(code0);

      // Early stop: if model diverges (same code0 repeated >20 frames after 60+ frames generated)
      if (step >= 60 && code0 === prevFirst[prevFirst.length - 2]) {
        let sameCount = 1;
        for (let k = prevFirst.length - 2; k >= 0 && prevFirst[k] === code0; k--, sameCount++);
        if (sameCount >= 20) {
          logger.warn(`[AR] early stop: code0=${code0} repeated ${sameCount} frames at step ${step}`);
          break;
        }
      }

      const th = new Float32Array(H);
      const hOff = hidden.length - H;
      for (let i = 0; i < H; i++) th[i] = hidden[hOff + i];

      const codes16 = new Int32Array(nGroups); codes16[0] = code0;
      for (let j = 1; j < nGroups; j++) {
        const gl = await this.predictResidual(th, codes16);
        const subLogits = new Float32Array(cpVocab);
        for (let i = 0; i < cpVocab; i++)
          subLogits[i] = gl[(j - 1) * cpVocab + i];
        codes16[j] = sampleToken(subLogits, { doSample: subDoSample, topK: subTopK, topP: subTopP, temperature: subTemperature, rng, protectedTokens: [codecEos] });
      }
      allCodes.push(new Int32Array(codes16));

      const nxt = await this.stepEmbed(codes16);
      const nxtT = new Float32Array(H);
      for (let i = 0; i < H; i++) nxtT[i] = nxt[i] + trailing[i];

      const pos = new Int32Array(3); for (let a = 0; a < 3; a++) pos[a] = total;
      const mask = new Int32Array(total + 1); mask.fill(1);

      result = await this.talkerCacheStep(nxtT, pos, mask, past, pastLen);
      logits = result.logits; hidden = result.hidden; past = result.present;
      total++;
      for (let i = 0; i < nPastTensors; i++) pastLen[i] = total;
    }
    if (allCodes.length >= maxFrames) {
      logger.warn(`[AR] hit hard limit: ${allCodes.length}/${maxFrames} frames — EOS was NEVER generated`);
    }
    return allCodes;
  }

  // ── Downstream models ──

  private async predictResidual(talkerHidden: Float32Array, codecIds: Int32Array): Promise<Float32Array> {
    const H = encodingRegistry.getTalkerHiddenSize();
    const nGroups = encodingRegistry.getNumCodeGroups();
    const res = await this.sm.runInference<{success:boolean;data:Record<string,ArrayBuffer>}>(
      'code_predictor',
      { talker_hidden: new Float32Array(talkerHidden), codec_ids: new Int32Array(codecIds) },
      { talker_hidden: [1, H], codec_ids: [1, nGroups] },
      'ar_loop',
    );
    return new Float32Array(res.data!['group_logits']);
  }

  private async stepEmbed(codecIds: Int32Array): Promise<Float32Array> {
    const nGroups = encodingRegistry.getNumCodeGroups();
    const res = await this.sm.runInference<{success:boolean;data:Record<string,ArrayBuffer>}>(
      'residual_embed',
      { codec_ids: new Int32Array(codecIds) },
      { codec_ids: [1, nGroups] },
      'ar_loop',
    );
    return new Float32Array(res.data!['step_embed']);
  }

  private async decodeChunked(codes: Int32Array): Promise<Float32Array> {
    const nGroups = encodingRegistry.getNumCodeGroups();
    const totalFrames = codes.length / nGroups;
    if (!Number.isInteger(totalFrames)) {
      throw new Error(`codes length ${codes.length} not multiple of ${nGroups}`);
    }
    const F = totalFrames;
    const parts: Float32Array[] = [];

    for (let s = 0; s < F; s += DEC_FRAMES) {
      const remaining = F - s;
      const chunk = new Int32Array(DEC_FRAMES * nGroups);

      if (remaining >= DEC_FRAMES) {
        const srcOff = s * nGroups;
        for (let i = 0; i < DEC_FRAMES * nGroups; i++) chunk[i] = codes[srcOff + i];
        parts.push(await this.decodeSingleChunk(chunk));
      } else {
        // Pad tail by repeating available frames
        for (let f = 0; f < DEC_FRAMES; f++) {
          const srcOff = (s + (f % remaining)) * nGroups;
          const dstOff = f * nGroups;
          for (let g = 0; g < nGroups; g++) chunk[dstOff + g] = codes[srcOff + g];
        }
        const wav = await this.decodeSingleChunk(chunk);
        parts.push(wav.slice(0, Math.round(wav.length * remaining / DEC_FRAMES)));
        break;
      }
    }

    let total = 0; for (const p of parts) total += p.length;
    const output = new Float32Array(total);
    let offset = 0; for (const p of parts) { output.set(p, offset); offset += p.length; }
    return output;
  }

  private async decodeSingleChunk(chunk: Int32Array): Promise<Float32Array> {
    const nGroups = encodingRegistry.getNumCodeGroups();
    const res = await this.sm.runInference<{success:boolean;data:Record<string,ArrayBuffer>}>(
      'tok_decoder',
      { audio_codes: chunk },
      { audio_codes: [1, DEC_FRAMES, nGroups] },
      'synthesis',
    );
    return new Float32Array(res.data!['waveform']);
  }

  // ── PCM → Int16 WAV ──

  pcmToWav(pcm: Float32Array): Blob {
    const numSamples = pcm.length;
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    view.setUint8(0,0x52); view.setUint8(1,0x49); view.setUint8(2,0x46); view.setUint8(3,0x46);
    view.setUint32(4, 36 + dataSize, true);
    view.setUint8(8,0x57); view.setUint8(9,0x41); view.setUint8(10,0x56); view.setUint8(11,0x45);
    view.setUint8(12,0x66); view.setUint8(13,0x6D); view.setUint8(14,0x74); view.setUint8(15,0x20);
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, SR, true); view.setUint32(28, SR * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    view.setUint8(36,0x64); view.setUint8(37,0x61); view.setUint8(38,0x74); view.setUint8(39,0x61);
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
      view.setInt16(offset, s, true);
      offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  // ═══════════════════════════════════════════════
  // Text preprocessing — normalize digits & mixed content
  // ═══════════════════════════════════════════════

  /** Preprocess text for TTS: split mixed alphanumeric tokens.
   *  Digits are NOT converted to words — the tokenizer handles them
   *  natively via the \p{N}{1,3} pre-tokenization regex pattern. */
  private preprocessText(text: string): string {
    let out = text;
    // Split mixed alphanumeric: insert space at letter-digit and digit-letter boundaries
    // "Qwen3TTS" → "Qwen 3 TTS" / "3T" → "3 T"
    out = out.replace(/([a-zA-Z])(\d)/g, '$1 $2');
    out = out.replace(/(\d)([a-zA-Z])/g, '$1 $2');
    // Split digit-hyphen-letter patterns like "3-T" in "Qwen3-TTS"
    // "Qwen3TTS" → "Qwen 3 TTS" / "Qwen3-TTS" → "Qwen 3 - TTS"
    // NOTE: 缩写词（如 TTS）不再逐字母拆分，否则 TTS 模型会按字母拼读，
    // 损害合成自然度。保留 "Qwen3" → "Qwen 3" 的字母↔数字边界拆分即可。
    out = out.replace(/(\d)(-)([a-zA-Z])/g, '$1 $2 $3');
    // Remove standalone hyphens — the model has no "dash" pronunciation token
    out = out.replace(/\b-\b/g, '');
    return out;
  }

  // ═══════════════════════════════════════════════
  // Python generate() prefill + AR + decode
  // ═══════════════════════════════════════════════

  async synthesize(input: TtsInputV2): Promise<{pcm:Float32Array; wav:Blob; durationSec:number}> {
    const synthStart = performance.now();
    const seed = input.seed ?? 0;
    const sampling = encodingRegistry.getSamplingDefaults();
    const temperature = input.temperature ?? sampling.temperature;
    const topK = input.topK ?? sampling.topK;
    const topP = input.topP ?? sampling.topP;
    const repetitionPenalty = input.repetitionPenalty ?? sampling.repetitionPenalty;
    const doSample = input.temperature !== undefined ? true : sampling.doSample;
    const rng = makeRng(seed);

    // Code predictor (residual token) sampling — independent subtalker_* params
    const subDoSample = encodingRegistry.getSubtalkerDoSample();
    const subTemperature = encodingRegistry.getSubtalkerTemperature();
    const subTopK = encodingRegistry.getSubtalkerTopK();
    const subTopP = encodingRegistry.getSubtalkerTopP();

    const H = encodingRegistry.getTalkerHiddenSize();
    const nGroups = encodingRegistry.getNumCodeGroups();

    // Text preprocessing: normalize digits and mixed alphanumeric content
    const processedText = this.preprocessText(input.text);

    // Explicit role tokenization: <|im_start|>assistant\n
    // Replaces the former inputIds.slice(0, 3) which hardcoded a 3-token assumption.
    // The ROLE_LEN is validated to be 3 for Qwen2 BPE, but the code now adapts
    // if the tokenizer produces a different count (e.g. if template format changes).
    const roleText = '<|im_start|>assistant\n';
    const roleIds = this.tokenize(roleText);
    const ROLE_LEN = roleIds.length;  // Verified: 3 for Qwen2 with corrected byteEncode

    // Instruct as user message (official format): text_proj only, BEFORE role
    // <|im_start|>user\n{instruct}<|im_end|>\n
    let instructBlock: Float32Array | null = null;
    let instructLen = 0;
    if (input.instruct) {
      const instructText = `<|im_start|>user\n${input.instruct}<|im_end|>\n`;
      const instructIds = this.tokenize(instructText);
      instructLen = instructIds.length;
      instructBlock = await this.embedText(instructIds);
    }

    const ttsBos = encodingRegistry.getTtsBos();
    const ttsEos = encodingRegistry.getTtsEos();
    const ttsPad = encodingRegistry.getTtsPad();
    const sp = await this.embedText(new Int32Array([ttsBos, ttsEos, ttsPad]));
    const bosE = sp.slice(0, H), eosE = sp.slice(H, 2 * H), padE = sp.slice(2 * H, 3 * H);

    const codecNothink = encodingRegistry.getCodecNothink();
    const codecThinkBos = encodingRegistry.getCodecThinkBos();
    const codecThinkEos = encodingRegistry.getCodecThinkEos();
    const codecPad = encodingRegistry.getCodecPad();
    const codecBos = encodingRegistry.getCodecBos();
    const codec0 = await this.embedCodec(new Int32Array([codecNothink, codecThinkBos, codecThinkEos]));
    const codec1 = await this.embedCodec(new Int32Array([codecPad, codecBos]));
    const P = codec0.length / H, Q = codec1.length / H;
    const codecInput = new Float32Array((P + Q) * H);
    for (let i = 0; i < P * H; i++) codecInput[i] = codec0[i];
    for (let i = 0; i < Q * H; i++) codecInput[P * H + i] = codec1[i];

    const role = await this.embedText(roleIds);
    const L1 = P + Q - 1;
    const codecPrefix = new Float32Array(L1 * H);
    for (let t = 0; t < L1; t++) {
      const pe = t < P + Q - 2 ? padE : bosE;
      for (let j = 0; j < H; j++) codecPrefix[t * H + j] = pe[j] + codecInput[t * H + j];
    }

    // Bos transition: tts_bos + codec_pad (bridges codec area to text area)
    const codecPadEmbed = codec1.slice(0, H);
    const bosTrans = new Float32Array(H);
    for (let j = 0; j < H; j++) bosTrans[j] = bosE[j] + codecPadEmbed[j];

    const bodyIds = this.tokenize(processedText);
    const bodyLen = bodyIds.length;
    const textBody = await this.embedText(bodyIds);

    const codecPadR = await this.embedCodec(new Int32Array(bodyLen + 1).fill(codecPad));
    const codecBosR = await this.embedCodec(new Int32Array([codecBos]));

    const block1 = new Float32Array((bodyLen + 1) * H);
    for (let t = 0; t < bodyLen; t++)
      for (let j = 0; j < H; j++) block1[t * H + j] = textBody[t * H + j] + codecPadR[t * H + j];
    for (let j = 0; j < H; j++) block1[bodyLen * H + j] = eosE[j] + codecPadR[bodyLen * H + j];

    const block2 = new Float32Array(H);
    for (let j = 0; j < H; j++) block2[j] = padE[j] + codecBosR[j];

    // talkerIn layout (official):
    // [instruct] [role] [codec_prefix] [bos_transition] [text_body+tts_eos] [trigger (pad+bos)]
    const totalT = instructLen + ROLE_LEN + L1 + 1 + (bodyLen + 1) + 1;
    const talkerIn = new Float32Array(totalT * H);
    let offset = 0;

    // 1. Instruct block (user message, text_proj only)
    if (instructBlock) {
      talkerIn.set(instructBlock, offset);
      offset += instructLen * H;
    }

    // 2. Role prefix (text_proj only)
    talkerIn.set(role, offset);
    offset += ROLE_LEN * H;

    // 3. Codec prefix (tts_pad + codec_emb per token)
    talkerIn.set(codecPrefix, offset);
    offset += L1 * H;

    // 4. Bos transition (tts_bos + codec_pad)
    talkerIn.set(bosTrans, offset);
    offset += H;

    // 5. Text body (text_proj + codec_pad per token) + tts_eos
    talkerIn.set(block1, offset);
    offset += (bodyLen + 1) * H;

    // 6. Trigger (tts_pad + codec_bos)
    talkerIn.set(block2, offset);

    // AR max frames from model config (generation_config.json max_new_tokens).
    // Cap at 500 for short-sentence use cases (8192 is for streaming/very long text).
    const maxFrames = Math.min(encodingRegistry.getMaxNewTokens(), 500);

    const codes = await this.arLoopCached(talkerIn, padE, seed, rng,
      doSample, topK, topP, temperature, repetitionPenalty,
      subDoSample, subTemperature, subTopK, subTopP, maxFrames,
      input.onProgress);

    if (codes.length === 0) throw new Error('AR loop produced zero frames');
    // EOS arrival diagnostic
    if (codes.length >= maxFrames) {
      logger.warn(`[synth] generated ${codes.length} frames (hard limit ${maxFrames}) — text may be too long or EOS not triggered. Audio duration: ~${(codes.length * 80 / 1000).toFixed(1)}s`);
    }
    const flatCodes = new Int32Array(codes.length * nGroups);
    for (let f = 0; f < codes.length; f++) flatCodes.set(codes[f], f * nGroups);
    let pcm = await this.decodeChunked(flatCodes);
    // Trim trailing noise/silence artifacts from AR loop tail
    const tailFadeSamples = Math.min(Math.floor(SR * 0.15), Math.floor(pcm.length * 0.05)); // 150ms or 5%
    if (tailFadeSamples > 0) {
      for (let i = 0; i < tailFadeSamples; i++) {
        const idx = pcm.length - tailFadeSamples + i;
        const fadeFactor = 1.0 - (i / tailFadeSamples);
        pcm[idx] *= fadeFactor;
      }
    }
    // Peak normalization — decoder output has very low amplitude (~0.001)
    const maxAbs = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const targetPeak = 0.95;  // leave 5% headroom to avoid clipping
    if (maxAbs > 1e-8) {
      const gain = targetPeak / maxAbs;
      for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
    }
    // RMS decay compensation — AR generation naturally decreases amplitude over time.
    // Measure RMS of first 25% vs last 25% frames; if late is significantly quieter,
    // apply a smooth linear gain ramp to equalize perceived loudness.
    const frameSize = Math.floor(SR * 0.02); // ~20ms frames
    const numFrames = Math.floor(pcm.length / frameSize);
    if (numFrames >= 4) {
      const earlyFrames = Math.max(1, Math.floor(numFrames * 0.25));
      const lateFrames = Math.max(1, Math.floor(numFrames * 0.25));
      const lateStart = numFrames - lateFrames;

      let earlyRms = 0, lateRms = 0;
      for (let f = 0; f < earlyFrames; f++) {
        let sum = 0;
        const off = f * frameSize;
        for (let i = 0; i < frameSize; i++) sum += pcm[off + i] * pcm[off + i];
        earlyRms += Math.sqrt(sum / frameSize);
      }
      earlyRms /= earlyFrames;

      for (let f = lateStart; f < numFrames; f++) {
        let sum = 0;
        const off = f * frameSize;
        for (let i = 0; i < frameSize; i++) sum += pcm[off + i] * pcm[off + i];
        lateRms += Math.sqrt(sum / frameSize);
      }
      lateRms /= lateFrames;

      // Only compensate if decay is significant (>30% drop)
      if (lateRms > 0 && earlyRms > 0 && lateRms < earlyRms * 0.7) {
        const decay = lateRms / earlyRms;
        const maxGain = Math.min(earlyRms / lateRms, 12.0); // cap at 12x (raised from 8x — analysis shows 0.70-0.86 decay ratios)
        for (let i = 0; i < pcm.length; i++) {
          const t = i / pcm.length; // 0→1 over duration
          const rampGain = 1.0 + (maxGain - 1.0) * t; // linear ramp
          pcm[i] *= rampGain;
        }
      }
    }
    // Speed adjustment via linear interpolation resampling
    const speed = input.speed ?? 1.0;
    if (speed !== 1.0 && speed > 0) {
      const newLen = Math.round(pcm.length / speed);
      const resampled = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) {
        const srcIdx = i * speed;
        const srcFloor = Math.floor(srcIdx);
        const srcCeil = Math.min(srcFloor + 1, pcm.length - 1);
        const frac = srcIdx - srcFloor;
        resampled[i] = pcm[srcFloor] * (1 - frac) + pcm[srcCeil] * frac;
      }
      pcm = resampled;
    }
    if (input.onProgress) {
      input.onProgress(92, '正在合成，请稍后。。。（92%）');
    }
    const wav = this.pcmToWav(pcm);
    return { pcm, wav, durationSec: pcm.length / SR };
  }
}
