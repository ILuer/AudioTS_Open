/**
 * src/lib/buildInstruct.ts — 风格维度目录 + 确定性 instruct 拼接
 *
 * 纯函数 `buildInstruct` 依据方言 / 年龄 / 性别 / 个性 拼接出 VoiceDesign 的
 * instruct 文本（例：「用四川话说，甜美活泼的青年女声」），与原型逻辑 1:1 对齐。
 *
 * 同时导出调音台所需的维度选项目录（方言 / 年龄 / 性别 / 个性分组 / 语言）
 * 与语言码→中文标签映射，供 VoiceDesignTab 复用。
 */

/** buildInstruct 入参（方言/年龄/性别允许为 null 表示未选） */
export interface BuildInstructInput {
  dialect: string | null;
  age: string | null;
  gender: string | null;
  personality: string[];
}

/**
 * 拼接 instruct。规则：
 * - base = 年龄+性别 / 仅性别 / 仅年龄
 * - qual = 个性用「、」连接
 * - 方言（非普通话）加「用{x}说，」前缀
 */
export function buildInstruct(input: BuildInstructInput): string {
  const { dialect, age, gender, personality } = input;

  let base = '';
  if (age && gender) base = `${age}${gender}`;
  else if (gender) base = gender;
  else if (age) base = age;

  const qual = [...personality].join('、');
  const dialectPrefix = dialect && dialect !== '普通话' ? `用${dialect}说，` : '';

  let body = '';
  if (qual && base) body = `${qual}的${base}`;
  else if (qual) body = qual;
  else if (base) body = base;

  return dialectPrefix + body;
}

/** 方言选项（含分组，与原型 DIALECT_OPTS 一致） */
const DIALECT_GROUPS: { group: string; items: string[] }[] = [
  { group: '官话 / 北方', items: ['北京话', '天津话', '陕西话', '南京话'] },
  { group: '西南官话', items: ['四川话'] },
  { group: '吴语', items: ['上海话'] },
  { group: '粤语', items: ['粤语'] },
  { group: '闽语', items: ['闽南话'] },
  { group: '基线（无口音）', items: ['普通话'] },
];

export interface ComboOption {
  value: string;
  label: string;
  group?: string;
}

export const DIALECT_OPTIONS: ComboOption[] = DIALECT_GROUPS.flatMap((g) =>
  g.items.map((it) => ({ value: it, label: it, group: g.group })),
);

export const AGE_OPTIONS: ComboOption[] = ['幼儿', '儿童', '少年', '青年', '中年', '老年'].map(
  (it) => ({ value: it, label: it }),
);

export const GENDER_OPTIONS: ComboOption[] = ['女声', '男声', '中性声'].map((it) => ({
  value: it,
  label: it,
}));

/** 个性 / 气质 分组（多选） */
export const PERSONALITY_GROUPS: { name: string; items: string[] }[] = [
  { name: '温度 · 情绪', items: ['温柔', '甜美', '亲切', '温暖', '治愈', '活泼', '俏皮', '欢快', '幽默'] },
  { name: '稳重 · 专业', items: ['沉稳', '冷静', '理性', '知性', '专业', '庄重', '威严', '权威'] },
  { name: '质感 · 表现力', items: ['磁性', '深情', '激昂', '热情', '慵懒', '清冷', '空灵'] },
  { name: '场景腔调', items: ['新闻播音腔', '电台主播腔', '故事讲述腔', '朗诵腔', '客服腔'] },
];

/** 语言选项（与原型 select 选项一致；真实 token id 由 encodingRegistry 解析） */
export const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Auto', label: 'Auto · 自动' },
  { value: 'chinese', label: '中文' },
  { value: 'english', label: 'English' },
  { value: 'japanese', label: '日本語' },
  { value: 'korean', label: '한국어' },
  { value: 'french', label: 'Français' },
  { value: 'spanish', label: 'Español' },
  { value: 'german', label: 'Deutsch' },
  { value: 'russian', label: 'Русский' },
  { value: 'italian', label: 'Italiano' },
  { value: 'portuguese', label: 'Português' },
];

/** 语言码 → 中文/原生标签 */
export function langLabel(value: string): string {
  return LANGUAGE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
