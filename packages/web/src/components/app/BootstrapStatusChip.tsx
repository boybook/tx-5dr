import { useMemo, useState } from 'react';
import { Button, Chip, Popover, PopoverContent, PopoverTrigger, Spinner } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { UserRole, type BootstrapPhaseStatus, type BootstrapStatus } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useRadioState } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';

const DISMISS_PREFIX = 'tx5dr_bootstrap_dismissed_';

function getDismissed(sessionId: string): boolean {
  try {
    return localStorage.getItem(`${DISMISS_PREFIX}${sessionId}`) === '1';
  } catch {
    return false;
  }
}

function setDismissed(sessionId: string): void {
  try {
    localStorage.setItem(`${DISMISS_PREFIX}${sessionId}`, '1');
  } catch {
    // Ignore storage failures; the chip can stay visible for this session.
  }
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function phaseTone(phase: BootstrapPhaseStatus): 'success' | 'warning' | 'danger' | 'default' | 'primary' {
  switch (phase.state) {
    case 'ready':
    case 'skipped':
      return 'success';
    case 'warning':
    case 'timed_out':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'running':
      return 'primary';
    default:
      return 'default';
  }
}

function phaseText(phase: BootstrapPhaseStatus): string {
  switch (phase.state) {
    case 'pending':
      return '等待中';
    case 'running':
      return '准备中';
    case 'ready':
      return '就绪';
    case 'skipped':
      return '已跳过';
    case 'warning':
      return '需注意';
    case 'failed':
      return '失败';
    case 'timed_out':
      return '耗时较长';
    default:
      return phase.state;
  }
}

function visiblePhases(status: BootstrapStatus): BootstrapPhaseStatus[] {
  return status.phases.filter(phase => phase.userVisible !== false);
}

function chipCopy(status: BootstrapStatus): { label: string; color: 'primary' | 'warning' | 'danger' } {
  if (status.lifecycle === 'failed') {
    return { label: '部分功能未准备好', color: 'danger' };
  }
  if (status.lifecycle === 'degraded') {
    return { label: '部分功能准备时间较长', color: 'warning' };
  }
  return { label: '正在准备后台服务...', color: 'primary' };
}

export function BootstrapStatusChip(): JSX.Element | null {
  const { state, dispatch } = useRadioState();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const status = state.bootstrapStatus;
  const [dismissedSession, setDismissedSession] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const shouldShow = useMemo(() => {
    if (!status) return false;
    if (status.lifecycle === 'completed' || status.lifecycle === 'dismissed') return false;
    if (!['booting', 'degraded', 'failed'].includes(status.lifecycle)) return false;
    if (dismissedSession === status.bootSessionId) return false;
    return !getDismissed(status.bootSessionId);
  }, [dismissedSession, status]);

  if (!status || !shouldShow) {
    return null;
  }

  const copy = chipCopy(status);
  const phases = visiblePhases(status);
  const running = status.summary.running > 0 && status.lifecycle === 'booting';
  const canRetry = isAdmin
    && status.lifecycle !== 'booting'
    && phases.some(phase => phase.retryable && ['failed', 'timed_out', 'warning'].includes(phase.state));

  const handleDismiss = () => {
    setDismissed(status.bootSessionId);
    setDismissedSession(status.bootSessionId);
  };

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      const nextStatus = await api.retryBootstrapStatus();
      dispatch({ type: 'bootstrapStatusChanged', payload: nextStatus });
      addToast({ title: '已开始重试启动准备项', color: 'primary', timeout: 2500 });
    } catch (error) {
      addToast({
        title: '无法重试启动准备项',
        description: error instanceof Error ? error.message : String(error),
        color: 'danger',
        timeout: 4000,
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const handleViewLogs = async () => {
    try {
      const runtimeInfo = await api.getPluginRuntimeInfo();
      if (window.electronAPI?.shell?.openPath) {
        await window.electronAPI.shell.openPath(runtimeInfo.logsDir);
        return;
      }
      addToast({
        title: '日志目录',
        description: runtimeInfo.logsDir,
        color: 'default',
        timeout: 6000,
      });
    } catch (error) {
      addToast({
        title: '无法打开日志目录',
        description: error instanceof Error ? error.message : String(error),
        color: 'danger',
        timeout: 4000,
      });
    }
  };

  return (
    <div className="fixed left-1/2 top-2 z-[9000] -translate-x-1/2 pointer-events-auto">
      <Popover placement="bottom" showArrow>
        <PopoverTrigger>
          <button type="button" className="outline-none" aria-label="查看启动状态">
            <Chip
              size="sm"
              color={copy.color}
              variant="shadow"
              className="cursor-pointer border border-white/30 px-2 text-xs backdrop-blur"
              startContent={running ? <Spinner size="sm" color="current" className="scale-75" /> : undefined}
            >
              {copy.label}
            </Chip>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(92vw,420px)] p-0">
          <div className="w-full p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-foreground">后台服务启动状态</div>
                <div className="mt-1 text-xs text-default-500">
                  不影响已就绪功能的正常使用。全部准备完成后提示会自动消失。
                </div>
              </div>
              <Button size="sm" variant="light" className="h-7 px-2 text-xs" onPress={handleDismiss}>
                暂不提示
              </Button>
            </div>

            <div className="mt-3 space-y-2">
              {phases.map((phase) => (
                <div key={phase.id} className="rounded-lg bg-content2/70 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-foreground">{phase.label}</div>
                      <div className="truncate text-[11px] text-default-500">
                        {phase.message || phase.description || '正在检查状态'}
                      </div>
                    </div>
                    <Chip size="sm" variant="flat" color={phaseTone(phase)} className="h-5 shrink-0 text-[10px]">
                      {phaseText(phase)}
                    </Chip>
                  </div>
                  {phase.durationMs !== undefined && (
                    <div className="mt-1 text-[10px] text-default-400">
                      用时 {formatDuration(phase.durationMs)}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {(status.lifecycle === 'degraded' || status.lifecycle === 'failed') && (
              <div className="mt-3 flex justify-end gap-2">
                {isAdmin && (
                  <Button size="sm" variant="flat" className="h-7 text-xs" onPress={handleViewLogs}>
                    查看日志
                  </Button>
                )}
                {canRetry && (
                  <Button
                    size="sm"
                    color="primary"
                    variant="flat"
                    className="h-7 text-xs"
                    isLoading={isRetrying}
                    onPress={handleRetry}
                  >
                    重试
                  </Button>
                )}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
