/**
 * src/types/index.ts — 类型定义统一导出
 */

export type { ModelFileInfo, ModelLoadState, ModelLoaderConfig, ModelMode, ModelLoadResult, DownloadGuideData } from './model';
export { ModelStatus, AppError } from './model';

export type { CompatibilityItem, CompatibilityReport, BrowserGrade } from './compatibility';

export type { SessionConfig, SessionHandle, SessionState, SessionEvent } from './session';

export type { InferenceResult, SelfTestReport, MemorySnapshot } from './inference';

export type { OutboundMessage, InboundMessage, TaskQueueItem, WorkerStatus, WorkerStatusSnapshot } from './worker';

export type { TabId, UIState, StatusBarState, PerfMetric, PerfSummary } from './ui';

export type { ExecutionProvider, EPCheckResult, EPStatus } from './ep';

export type {
  SynthesisStage,
  SynthesisProgress,
  SynthesisResult,
  StageTiming,
  TextTemplate,
  ParamType,
  ParamGroup,
  VdLanguageOption,
  VoiceDesignParamSpec,
  VoiceDesignParams,
  VoiceProfile,
  ScriptRow,
} from './voice';

// ── 配置驱动编码（encoding.ts） ──
export type {
  RawConfig,
  RawTalkerConfig,
  RawCodePredictorConfig,
  RawGenerationConfig,
  RawPreprocessorConfig,
  RawTokenizerConfig,
  AddedTokenEntry,
  CodecTokens,
  TtsTokens,
  ChatTokens,
  TalkerParams,
  SamplingDefaults,
  PreprocessingParams,
  ModelConfig,
} from './encoding';
export {
  ConfigError,
  FALLBACK_SAMPLING_DEFAULTS,
  FALLBACK_PREPROCESSING,
} from './encoding';

// ModelSet / ModelSetId 类型与值均来自 src/core/modelSet.ts（types 不重复定义，避免循环）
export type { ModelSet, ModelSetId } from '../core/modelSet';

export {
  VOICEDESIGN_MODEL_SET,
  getModelPath as getModelSetPath,
  getManifestPath as getModelSetManifestPath,
  modelNameFromFile,
} from '../core/modelSet';
