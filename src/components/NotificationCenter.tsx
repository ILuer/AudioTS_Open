/**
 * src/components/NotificationCenter.tsx — 分级通知中心（检测隐形化反馈层）
 *
 * 订阅 eventBus 的 DIAGNOSTIC_ISSUE，按 Severity 分级渲染：
 *  - critical → 全屏遮罩浮层（modal/mask），必须由用户手动关闭/处理，不自动消失。
 *  - warning  → 顶部 toast，~8s 自动消失，可手动关闭。
 *  - info     → 轻量顶部 toast，~5s 自动消失（按零打扰原则仅短暂展示重要信息）。
 *
 * 样式复用原型令牌（notifications.css）与 tokens.css 功能色/阴影。
 */

import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { eventBus, AppEvents } from '@/core/eventBus';
import type { DiagnosticResult, Severity } from '@/core/diagnostics';
import '@/styles/notifications.css';

const ICONS: Record<Severity, string> = {
  critical: '⛔',
  warning: '⚠️',
  info: 'ℹ️',
};

export const NotificationCenter: FC = () => {
  const [toasts, setToasts] = useState<DiagnosticResult[]>([]);
  const [activeCritical, setActiveCritical] = useState<DiagnosticResult | null>(null);

  // critical 同一时刻仅显示一个；其余进入队列，关闭当前后再弹出
  const activeCriticalRef = useRef<DiagnosticResult | null>(null);
  const criticalQueueRef = useRef<DiagnosticResult[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showNextCritical = useCallback(() => {
    const next = criticalQueueRef.current.shift() ?? null;
    activeCriticalRef.current = next;
    setActiveCritical(next);
  }, []);

  const dismissCritical = useCallback(() => {
    showNextCritical();
  }, [showNextCritical]);

  const handleIssue = useCallback(
    (raw: unknown) => {
      const result = raw as DiagnosticResult;
      if (!result || !result.severity) return;

      if (result.severity === 'critical') {
        if (activeCriticalRef.current) {
          criticalQueueRef.current.push(result);
        } else {
          activeCriticalRef.current = result;
          setActiveCritical(result);
        }
        return;
      }

      // warning / info → 顶部 toast，自动消失
      setToasts((prev) => [...prev, result]);
      const duration = result.severity === 'warning' ? 8000 : 5000;
      if (duration > 0) {
        window.setTimeout(() => dismissToast(result.id), duration);
      }
    },
    [dismissToast],
  );

  useEffect(() => {
    const off = eventBus.on(AppEvents.DIAGNOSTIC_ISSUE, (...args: unknown[]) => {
      handleIssue(args[0]);
    });
    return off;
  }, [handleIssue]);

  return (
    <>
      {/* 顶部 toast 堆叠容器 */}
      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.severity}`} role="status">
            <span className="t-ico" aria-hidden="true">
              {ICONS[t.severity]}
            </span>
            <div className="t-body">
              <div className="t-title">{t.title}</div>
              {t.message && <div className="t-msg">{t.message}</div>}
            </div>
            <button
              type="button"
              className="t-close"
              aria-label="关闭通知"
              onClick={() => dismissToast(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* critical 全屏遮罩浮层（不自动消失，必须手动处理） */}
      {activeCritical && (
        <div
          className="modal-mask show"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="nc-modal-title"
        >
          <div className="modal">
            <div className="m-ico" aria-hidden="true">
              {ICONS.critical}
            </div>
            <h3 id="nc-modal-title">{activeCritical.title}</h3>
            <p>{activeCritical.message}</p>
            <div className="m-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={dismissCritical}>
                关闭
              </button>
              {activeCritical.actionLabel && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    activeCritical.onAction?.();
                    dismissCritical();
                  }}
                >
                  {activeCritical.actionLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default NotificationCenter;
