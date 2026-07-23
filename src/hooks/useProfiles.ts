/**
 * src/hooks/useProfiles.ts — 音色档案 store（localStorage 持久化）
 *
 * 键值：localStorage['audiots-profiles']（JSON 数组，不含音频二进制）。
 * 首次无数据写入种子档案，保证 id 跨刷新稳定。
 * 全部经统一 logger 输出（无 console.*）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { VoiceProfile } from '@/types';
import { logger } from '@/core/logger';

const STORE_KEY = 'audiots-profiles';

/** 生成稳定档案 id */
export function createProfileId(): string {
  return 'p' + Math.random().toString(36).slice(2, 9);
}

/** 种子档案（与原型 SEED_PROFILES 对齐） */
function makeSeedProfiles(): VoiceProfile[] {
  return [
    {
      id: createProfileId(),
      name: '旁白',
      dialect: null,
      age: '中年',
      gender: '中性声',
      personality: ['专业', '沉稳'],
      instruct: '专业沉稳的旁白声',
      language: 'chinese',
      speed: 1.0,
      seed: 20240701,
      params: { temperature: 0.9, topK: 20, topP: 0.85, repetitionPenalty: 1.05 },
      note: '全剧旁白统一音色，压低情绪、清晰叙事。',
      referenceAudio: null,
    },
    {
      id: createProfileId(),
      name: '男主·林深',
      dialect: null,
      age: '青年',
      gender: '男声',
      personality: ['沉稳', '深情'],
      instruct: '青年男声，沉稳而深情',
      language: 'chinese',
      speed: 1.0,
      seed: 20240702,
      params: { temperature: 0.9, topK: 20, topP: 0.85, repetitionPenalty: 1.05 },
      note: '男主角，内敛克制。',
      referenceAudio: null,
    },
    {
      id: createProfileId(),
      name: '女主·苏晚',
      dialect: null,
      age: '青年',
      gender: '女声',
      personality: ['甜美', '活泼'],
      instruct: '青年女声，甜美活泼',
      language: 'chinese',
      speed: 1.05,
      seed: 20240703,
      params: { temperature: 0.9, topK: 20, topP: 0.85, repetitionPenalty: 1.05 },
      note: '女主角，明快有活力。',
      referenceAudio: null,
    },
    {
      id: createProfileId(),
      name: '反派·陈boss',
      dialect: null,
      age: '中年',
      gender: '男声',
      personality: ['威严', '磁性'],
      instruct: '中年男声，威严磁性',
      language: 'chinese',
      speed: 0.95,
      seed: 20240704,
      params: { temperature: 0.92, topK: 18, topP: 0.82, repetitionPenalty: 1.08 },
      note: '反派 Boss，压迫感强。',
      referenceAudio: null,
    },
    {
      id: createProfileId(),
      name: '路人甲',
      dialect: null,
      age: '青年',
      gender: '男声',
      personality: ['亲切'],
      instruct: '青年男声，亲切自然',
      language: 'chinese',
      speed: 1.0,
      seed: 20240705,
      params: { temperature: 0.9, topK: 20, topP: 0.85, repetitionPenalty: 1.05 },
      note: '路人角色通用。',
      referenceAudio: null,
    },
  ];
}

function loadProfiles(): VoiceProfile[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as VoiceProfile[];
      }
    }
  } catch (err) {
    logger.warn('Profile', '读取音色档案失败，回退到种子数据', err);
  }
  // 首次无数据：写入种子，保证 id 稳定
  const seeds = makeSeedProfiles();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(seeds));
  } catch {
    /* 忽略配额错误 */
  }
  return seeds;
}

function persist(profiles: VoiceProfile[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(profiles));
  } catch (err) {
    logger.warn('Profile', '音色档案持久化失败', err);
  }
}

export interface UseProfilesReturn {
  profiles: VoiceProfile[];
  /** 新增或更新（按 id 合并） */
  save: (profile: VoiceProfile) => void;
  /** 删除（按 id） */
  remove: (id: string) => void;
}

/**
 * 音色档案 store Hook。
 */
export function useProfiles(): UseProfilesReturn {
  const [profiles, setProfiles] = useState<VoiceProfile[]>(() => loadProfiles());

  // 状态变更即持久化（首次挂载也会落地一次，幂等无副作用）
  useEffect(() => {
    persist(profiles);
  }, [profiles]);

  const save = useCallback((profile: VoiceProfile) => {
    setProfiles((prev) => {
      const idx = prev.findIndex((p) => p.id === profile.id);
      return idx >= 0
        ? prev.map((p) => (p.id === profile.id ? profile : p))
        : [...prev, profile];
    });
  }, []);

  const remove = useCallback((id: string) => {
    setProfiles((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { profiles, save, remove };
}
