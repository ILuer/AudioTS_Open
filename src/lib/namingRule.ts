/**
 * src/lib/namingRule.ts — 配音台下载命名规则 + WAV/ZIP 产出
 *
 * - summarize：台词概略（去标点、截断约 12 字），与原型 fileNameOf 规则 1:1 对齐。
 * - fileNameOf：下载文件名 `序号.角色.情绪.台词概略.wav`（情绪为「—」时省略）。
 * - downloadBlob：触发浏览器下载（自动回收 Object URL）。
 * - buildZip：极简 stored 方法 ZIP 打包（无外部依赖，与架构 §7.3 自实现方案一致）。
 *
 * 真实音频来自推理产出的 Blob，禁止任何 mock（如原型 makeWavBytes）。
 */

/** 去标点并截断约 12 字（用于「台词概略」） */
export function summarize(line: string): string {
  const punct =
    /[，。！？、；：“”‘’（）《》…—.,!?;:""''()\[\]{}<>\-\s\/\\|]/g;
  return (line || '').replace(punct, '').slice(0, 12);
}

/** 下载文件名规则：序号.角色.情绪.台词概略.wav */
export function fileNameOf(row: {
  index: number;
  role: string;
  emotion?: string;
  text: string;
}): string {
  const emo = row.emotion && row.emotion !== '—' ? row.emotion : '';
  return `${row.index}.${row.role}.${emo}.${summarize(row.text)}.wav`;
}

/** 触发浏览器下载（自动回收 Object URL） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ────────────────────────────────────────────────────────────
// 极简 ZIP（stored 方法，无外部依赖，搬自原型 buildZip）
// ────────────────────────────────────────────────────────────

/** CRC32 表（IEEE） */
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(arr: Uint8Array[]): Uint8Array {
  let len = 0;
  arr.forEach((b) => {
    len += b.length;
  });
  const out = new Uint8Array(len);
  let o = 0;
  arr.forEach((b) => {
    out.set(b, o);
    o += b.length;
  });
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 打包为 ZIP（stored，无压缩），返回原始字节 */
export function buildZip(files: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  let offset = 0;
  const centrals: Uint8Array[] = [];

  files.forEach((f) => {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    let o = 0;
    const u16 = (v: number) => {
      lv.setUint16(o, v, true);
      o += 2;
    };
    const u32 = (v: number) => {
      lv.setUint32(o, v >>> 0, true);
      o += 4;
    };
    lv.setUint32(o, 0x04034b50, true);
    o += 4;
    u16(20);
    u16(0x0800);
    u16(0);
    u16(0);
    u16(0);
    u32(crc);
    u32(data.length);
    u32(data.length);
    u16(nameBytes.length);
    u16(0);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const localStart = offset;
    offset += local.length;

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    let co = 0;
    const cu16 = (v: number) => {
      cv.setUint16(co, v, true);
      co += 2;
    };
    const cu32 = (v: number) => {
      cv.setUint32(co, v >>> 0, true);
      co += 4;
    };
    cv.setUint32(co, 0x02014b50, true);
    co += 4;
    cu16(20);
    cu16(20);
    cu16(0x0800);
    cu16(0);
    cu16(0);
    cu16(0);
    cu32(crc);
    cu32(data.length);
    cu32(data.length);
    cu16(nameBytes.length);
    cu16(0);
    cu16(0);
    cu16(0);
    cu32(0);
    cu32(localStart);
    cd.set(nameBytes, 46);
    centrals.push(cd);
  });

  const centralBuf = concatBytes(centrals);
  const centralOffset = offset;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  let eo = 0;
  ev.setUint32(eo, 0x06054b50, true);
  eo += 4;
  ev.setUint16(eo, 0, true);
  eo += 2;
  ev.setUint16(eo, 0, true);
  eo += 2;
  ev.setUint16(eo, files.length, true);
  eo += 2;
  ev.setUint16(eo, files.length, true);
  eo += 2;
  ev.setUint32(eo, centralBuf.length, true);
  eo += 4;
  ev.setUint32(eo, centralOffset, true);
  eo += 4;
  ev.setUint16(eo, 0, true);
  eo += 2;

  return concatBytes([...locals, centralBuf, end]);
}
