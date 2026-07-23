/**
 * src/lib/scriptXlsx.ts — 配音台 xlsx 台本解析与模板下载
 *
 * 设计要点（与 DubbingTab.parseScript 严格对齐）：
 *   - 解析出的每一行结构 `ParsedLine` 与 txt 解析的 `ParsedLine` **完全一致**
 *     （idx / role / emotion / line / malformed），因此 DubbingTab 的
 *     applyParsed / loadScript 可零分支复用同一套映射逻辑，最终都产出
 *     结构一致的 `ScriptRow[]`，后续批量合成流程无任何差异。
 *   - xlsx 模板按「列」表达字段（序号 / 角色 / 情绪 / 台词），不使用「-」分隔符，
 *     与 txt 模板的「序号-角色-情绪-台词」示意一一对应。
 *
 * 依赖：SheetJS（xlsx）仅在本文件内 import，避免污染 DubbingTab。
 */

import * as XLSX from 'xlsx';
import { downloadBlob } from '@/lib/namingRule';

/** 解析后的一行（与 DubbingTab 内 parseScript 返回的 ParsedLine 同构） */
export interface ParsedLine {
  idx: number;
  role: string;
  emotion: string;
  line: string;
  malformed?: boolean;
}

/**
 * 解析 xlsx / xls 台本（表格列：序号 / 角色 / 情绪 / 台词）。
 *
 * @param arrayBuffer 文件读取出的 ArrayBuffer
 * @returns ParsedLine[]（已跳过表头第 1 行）
 *
 * 规则：
 *   - 第 0 行为表头（序号 / 角色 / 情绪 / 台词），跳过。
 *   - 从第 1 行起：列 A=序号、B=角色、C=情绪、D=台词。
 *   - idx = 有限且 >0 的序号，否则用 1 基数据行序号兜底（首条数据行=1，与 txt 对齐）。
 *   - role / text 为空 → 标记 malformed（与 txt 解析的「格式不完整」语义一致）。
 */
export function parseXlsx(arrayBuffer: ArrayBuffer): ParsedLine[] {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: '',
  }) as unknown[][];

  const out: ParsedLine[] = [];
  // 第 0 行为表头，从 1 开始
  let dataRow = 0; // 1 基数据行计数器，使缺序号行的兜底序号与 txt 对齐（首条数据行=1）
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    dataRow++; // 自增数据行计数（跳过表头，仅统计有效数据行）
    const a = row[0];
    const b = row[1];
    const c = row[2];
    const d = row[3];

    const seq = Number(a);
    const idx = Number.isFinite(seq) && seq > 0 ? seq : dataRow;
    const role = String(b ?? '').trim();
    const emotion = String(c ?? '').trim() || '—';
    const line = String(d ?? '').trim();

    const malformed = !role || !line;
    out.push({
      idx,
      role,
      emotion,
      line,
      malformed: malformed || undefined,
    });
  }
  return out;
}

/**
 * 下载 xlsx 台词模板（按列：序号 / 角色 / 情绪 / 台词，无分隔符）。
 * 复用 namingRule.downloadBlob，文件名 `AudioTS_台词模板.xlsx`。
 */
export function downloadXlsxTemplate(): void {
  const aoa: (string | number)[][] = [
    ['序号', '角色', '情绪', '台词'],
    [1, '旁白', '平静', '在很久很久以前，云雾缭绕的山谷里，住着一位老药师。'],
    [2, '男主·林深', '悲伤', '你终于来了。我还以为，你不会再回来了。'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '台词');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, 'AudioTS_台词模板.xlsx');
}
