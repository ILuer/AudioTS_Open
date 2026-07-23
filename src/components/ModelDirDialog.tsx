/**
 * src/components/ModelDirDialog.tsx — 模型目录配置对话框（去 MUI 化）
 * ======================================================
 *
 * 用纯 HTML + 原型 .modal-mask / .modal 风格重写，移除原 MUI 组件
 * （Dialog/Button/Alert/Link/Typography/Box/CircularProgress）及图标（改用 emoji）。
 *
 * 完整保留既有行为（不破坏任何已交付功能）：
 *  - 通过 webkitdirectory 选择本地文件夹（非 FSAA，与原实现一致）
 *  - 选中后 setModelDir(dirName) 并记录，onConfigured(Array.from(files))
 *    把 File[] 交给上层（App.tsx 负责读取 .onnx 并注入 ModelLoader）
 *  - errorMessage 展示（来自 App 的模型加载失败提示）
 *  - HF 下载链接（emoji + ↗）
 *  - 首次自动弹窗 / 失败重弹 由 App 通过 open 控制，本组件仅渲染
 * 零服务端、零上传。图标改用 emoji / 内联字符。
 */

import { type FC, useState, useRef } from 'react';
import { setModelDir, getModelDir } from '@/core/modelDir';
import '@/styles/controls.css';

const HF_CPU_INT4_URL =
  'https://huggingface.co/onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign/tree/main/cpu_int4';

interface Props {
  open: boolean;
  onConfigured: (files: File[]) => void;
  errorMessage?: string;
}

export const ModelDirDialog: FC<Props> = ({ open, onConfigured, errorMessage }) => {
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentDir = getModelDir();

  const handleChange = () => {
    const files = inputRef.current?.files;
    if (!files || files.length === 0) return;
    const dirName = files[0].webkitRelativePath.split('/')[0];
    setModelDir(dirName);
    setPicking(true);
    // 传递 File 对象给上层——由 App 负责读取并注入 ModelLoader
    onConfigured(Array.from(files));
    setPicking(false);
  };

  if (!open) return null;

  return (
    <div
      className="modal-mask show"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modeldir-title"
    >
      <div className="modal">
        <h3 id="modeldir-title">选择模型文件夹</h3>

        <div className="md-body">
          {errorMessage && (
            <div className="alert alert-error" role="alert">
              <span className="a-ico" aria-hidden="true">
                ⛔
              </span>
              <span>{errorMessage}</span>
            </div>
          )}

          <p className="md-dir">
            当前模型目录：<strong>{currentDir}</strong>
          </p>

          <p className="md-desc">
            点击下方按钮，<strong>选择包含 .onnx 文件的本地文件夹</strong>。
            浏览器直接读取——不上传、无服务端。
          </p>

          <div className="md-pick">
            <input
              ref={inputRef}
              type="file"
              // @ts-expect-error webkitdirectory
              webkitdirectory=""
              directory=""
              multiple
              style={{ display: 'none' }}
              onChange={handleChange}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => inputRef.current?.click()}
              disabled={picking}
            >
              {picking ? '读取中...' : '📁 选择本地模型文件夹'}
            </button>
          </div>

          <div className="alert alert-info">
            <span className="a-ico" aria-hidden="true">
              ℹ️
            </span>
            <span>文件夹中需包含全部 8 个 .onnx 模型文件 + manifest.json（约 2.7 GB）。</span>
          </div>

          <a className="md-hf" href={HF_CPU_INT4_URL} target="_blank" rel="noopener noreferrer">
            📦 从 HuggingFace 下载模型文件 <span className="md-ext" aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </div>
  );
};
