import { useState, useEffect, useRef } from 'react';
import { Button, Spinner } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlug } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import type { RadioService } from '@tx5dr/core';

interface ServerDisconnectedOverlayProps {
  isConnected: boolean;
  isConnecting: boolean;
  radioService: RadioService | null;
}

export function ServerDisconnectedOverlay({ isConnected, isConnecting, radioService }: ServerDisconnectedOverlayProps) {
  const [isManualConnecting, setIsManualConnecting] = useState(false);
  // 控制动画：visible 决定是否渲染，shown 控制 opacity
  const [visible, setVisible] = useState(!isConnected);
  const [shown, setShown] = useState(!isConnected);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isConnected) {
      // 断连：立即显示
      setVisible(true);
      // 下一帧设置 opacity 触发淡入
      requestAnimationFrame(() => setShown(true));
    } else {
      // 连接恢复：淡出
      setShown(false);
      // 动画结束后卸载
      timerRef.current = setTimeout(() => setVisible(false), 300);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isConnected]);

  // 连接恢复后重置手动连接状态
  useEffect(() => {
    if (isConnected) {
      setIsManualConnecting(false);
    }
  }, [isConnected]);

  const handleReconnect = async () => {
    if (!radioService) return;
    setIsManualConnecting(true);
    try {
      await radioService.connect();
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      const env = import.meta.env.DEV ? 'development' : 'production';
      const isInElectron = (() => {
        try { return typeof window !== 'undefined' && window.navigator.userAgent.includes('Electron'); } catch { return false; }
      })();
      const lines: string[] = [];
      if (errMsg.includes('未启动') || errMsg.includes('不可达')) {
        lines.push('原因：后端服务未启动或不可达');
      }
      if (env === 'development') {
        lines.push('排查：请先启动后端服务：yarn workspace @tx5dr/server dev');
        lines.push('查看：终端窗口中的后端日志，确认4000端口是否监听');
      } else if (isInElectron) {
        lines.push('排查：请重启应用；若仍失败，请在系统日志/控制台查看 Electron 主进程与后端日志');
      } else {
        lines.push('排查：确认部署环境中的后端服务进程已运行并监听 /api');
        lines.push('Docker：使用 docker-compose logs -f 查看容器日志');
      }
      addToast({
        title: '连接失败',
        description: `无法连接到服务器：${errMsg}。\n${lines.join('\n')}`,
      });
    } finally {
      setIsManualConnecting(false);
    }
  };

  if (!visible) return null;

  const connecting = isConnecting || isManualConnecting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md bg-background/60 transition-opacity duration-300"
      style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none' }}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        {connecting ? (
          <>
            <Spinner size="lg" color="primary" />
            <p className="text-default-500 text-sm">正在连接服务器...</p>
          </>
        ) : (
          <>
            <div className="w-16 h-16 rounded-full bg-default-100 flex items-center justify-center">
              <FontAwesomeIcon icon={faPlug} className="text-default-400 text-2xl" />
            </div>
            <div>
              <p className="text-default-700 font-medium">与服务器的连接已断开</p>
              <p className="text-default-400 text-sm mt-1">请检查网络或后端服务状态</p>
            </div>
            <Button
              color="primary"
              variant="flat"
              onPress={handleReconnect}
              className="mt-2"
            >
              重新连接
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
