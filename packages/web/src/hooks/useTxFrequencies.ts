import { useMemo } from 'react';
import { useOperators } from '../store/radioStore';

export interface TxFrequency {
  operatorId: string;
  frequency: number;
}

/**
 * 获取所有操作者的发射频率（TX频率）
 *
 * 从操作者上下文中读取设定的发射频率（context.frequency）
 *
 * @returns TX频率列表，每项包含操作者ID和频率
 */
export const useTxFrequencies = (): TxFrequency[] => {
  const { operators } = useOperators();

  const txFrequencies = useMemo(() => {
    const result: TxFrequency[] = [];

    // 遍历所有操作者
    for (const operator of operators) {
      const frequency = operator.context.frequency;

      // 如果设置了发射频率，添加到结果中
      if (frequency !== undefined && frequency !== null) {
        result.push({
          operatorId: operator.id,
          frequency: frequency
        });
      }
    }

    return result;
  }, [operators]);

  return txFrequencies;
};
