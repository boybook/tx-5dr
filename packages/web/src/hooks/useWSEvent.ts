import { useEffect, useRef } from 'react';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import type { RadioService } from '../services/radioService';

/**
 * WebSocket 事件订阅 Hook
 *
 * 自动管理事件监听器的订阅和清理，防止内存泄漏。
 *
 * @param radioService - RadioService 实例（如果为 null 则不订阅）
 * @param eventName - 要订阅的事件名称
 * @param handler - 事件处理函数
 * @param deps - 依赖数组（类似 useEffect），用于在依赖变化时重新订阅
 */
export function useWSEvent<K extends keyof DigitalRadioEngineEvents>(
  radioService: RadioService | null,
  eventName: K,
  handler: DigitalRadioEngineEvents[K],
  deps: React.DependencyList = []
): void {
  // 使用 ref 保存处理器函数，避免不必要的重新订阅
  const handlerRef = useRef(handler);

  // 每次 handler 变化时更新 ref
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  // 订阅事件
  useEffect(() => {
    // 如果没有 radioService，则不订阅
    if (!radioService) {
      return;
    }

    const wsClient = radioService.wsClientInstance;

    // 创建包装函数，使用最新的 handler
    const wrappedHandler: DigitalRadioEngineEvents[K] = ((...args: any[]) => {
      (handlerRef.current as any)(...args);
    }) as DigitalRadioEngineEvents[K];

    // 订阅事件
    wsClient.onWSEvent(eventName, wrappedHandler);

    // 清理函数：组件卸载或依赖变化时取消订阅
    return () => {
      wsClient.offWSEvent(eventName, wrappedHandler);
    };
  }, [radioService, eventName, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * 订阅多个 WebSocket 事件的 Hook
 *
 * 自动管理多个事件监听器的订阅和清理。
 *
 * @param radioService - RadioService 实例（如果为 null 则不订阅）
 * @param eventHandlers - 事件名称到处理函数的映射对象
 * @param deps - 依赖数组（类似 useEffect），用于在依赖变化时重新订阅
 */
export function useWSEvents(
  radioService: RadioService | null,
  eventHandlers: Partial<{
    [K in keyof DigitalRadioEngineEvents]: DigitalRadioEngineEvents[K];
  }>,
  deps: React.DependencyList = []
): void {
  // 使用 ref 保存处理器映射，避免不必要的重新订阅
  const handlersRef = useRef(eventHandlers);

  // 每次 eventHandlers 变化时更新 ref
  useEffect(() => {
    handlersRef.current = eventHandlers;
  }, [eventHandlers]);

  // 订阅所有事件
  useEffect(() => {
    // 如果没有 radioService，则不订阅
    if (!radioService) {
      return;
    }

    const wsClient = radioService.wsClientInstance;
    const wrappedHandlers = new Map<keyof DigitalRadioEngineEvents, (...args: any[]) => void>();

    // 为每个事件创建包装函数并订阅
    Object.entries(eventHandlers).forEach(([eventName, handler]) => {
      const wrappedHandler = (...args: any[]) => {
        const currentHandler = handlersRef.current[eventName as keyof DigitalRadioEngineEvents];
        if (currentHandler) {
          (currentHandler as any)(...args);
        }
      };

      wrappedHandlers.set(eventName as keyof DigitalRadioEngineEvents, wrappedHandler);
      wsClient.onWSEvent(eventName as keyof DigitalRadioEngineEvents, wrappedHandler as any);
    });

    // 清理函数：组件卸载或依赖变化时取消所有订阅
    return () => {
      wrappedHandlers.forEach((handler, eventName) => {
        wsClient.offWSEvent(eventName, handler as any);
      });
    };
  }, [radioService, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
