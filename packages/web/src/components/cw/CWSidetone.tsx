import { useEffect, useRef } from 'react';
import { useCWKeyer } from '../../hooks/useCWKeyer';

/**
 * CW 侧音组件 — 使用 Web Audio API 生成莫尔斯码侧音
 *
 * 当键控器处于 keying 状态时发出正弦波侧音。
 * 通过 cwKeyerStatus 事件驱动：mode === 'keying' 时发声。
 */
export function CWSidetone() {
  const { cwKeyerStatus } = useCWKeyer();
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const isSoundingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!cwKeyerStatus) return;

    const shouldSound = cwKeyerStatus.active && cwKeyerStatus.mode === 'keying';

    if (shouldSound && !isSoundingRef.current) {
      startTone();
    } else if (!shouldSound && isSoundingRef.current) {
      stopTone();
    }
  }, [cwKeyerStatus]);

  const startTone = () => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = 700;

      // 柔和包络避免咔嗒声
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.005);

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.start();

      oscillatorRef.current = oscillator;
      gainNodeRef.current = gainNode;
      isSoundingRef.current = true;
    } catch {
      // 音频不可用时静默
    }
  };

  const stopTone = () => {
    try {
      const ctx = audioCtxRef.current;
      const gainNode = gainNodeRef.current;
      const oscillator = oscillatorRef.current;

      if (gainNode && ctx) {
        gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.005);
      }

      // 延迟停止以允许释放包络
      setTimeout(() => {
        try {
          oscillator?.stop();
          oscillator?.disconnect();
          gainNode?.disconnect();
        } catch { /* already stopped */ }
      }, 10);

      oscillatorRef.current = null;
      gainNodeRef.current = null;
      isSoundingRef.current = false;
    } catch {
      // 静默处理
    }
  };

  // 不可见组件
  return null;
}
