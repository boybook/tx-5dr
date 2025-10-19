import { useMemo } from 'react';
import { useOperators, useSlotPacks } from '../store/radioStore';
import { FT8MessageParser } from '@tx5dr/core';

export interface RxFrequency {
  callsign: string;
  frequency: number;
}

/**
 * 获取所有操作者的通联目标的RX频率
 *
 * 从操作者上下文中获取 targetCall，然后从历史消息中查找包含该呼号的最新消息，
 * 提取其频率偏移（freq字段）
 *
 * @returns RX频率列表，每项包含呼号和频率
 */
export const useTargetRxFrequencies = (): RxFrequency[] => {
  const { operators } = useOperators();
  const { state: slotPacksState } = useSlotPacks();

  const rxFrequencies = useMemo(() => {
    const result: RxFrequency[] = [];

    // 遍历所有操作者
    for (const operator of operators) {
      const targetCall = operator.context.targetCall;

      // 如果没有通联目标，跳过
      if (!targetCall || targetCall.trim() === '') {
        continue;
      }

      // 从最新的 SlotPack 开始查找（倒序遍历）
      const slotPacks = [...slotPacksState.slotPacks].reverse();
      let foundFrequency: number | null = null;

      for (const slotPack of slotPacks) {
        // 在该 SlotPack 的所有 frames 中查找
        for (const frame of slotPack.frames) {
          // 解析FT8消息
          const parsed = FT8MessageParser.parseMessage(frame.message);

          // 检查解析结果是否包含senderCallsign字段
          // （UNKNOWN和CUSTOM类型没有此字段）
          if (!('senderCallsign' in parsed)) {
            continue;
          }

          // 只有当发送者是目标呼号时才记录频率
          if (parsed.senderCallsign === targetCall) {
            // 排除自己发送的消息（我的TX消息不应被标记为RX）
            if (parsed.senderCallsign !== operator.context.myCall) {
              foundFrequency = frame.freq;
              break;
            }
          }
        }

        // 如果找到了，停止搜索
        if (foundFrequency !== null) {
          break;
        }
      }

      // 如果找到了频率，添加到结果中
      if (foundFrequency !== null) {
        result.push({
          callsign: targetCall,
          frequency: foundFrequency
        });
      }
    }

    return result;
  }, [operators, slotPacksState.slotPacks]);

  return rxFrequencies;
};
