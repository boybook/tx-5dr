import * as React from 'react';
import { Select, SelectItem, Input, Button, Switch, Selection, Tooltip, Popover, PopoverTrigger, PopoverContent } from "@heroui/react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faWandMagicSparkles, faRepeat, faBook, faRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useCurrentOperatorId, useOperators, useRadioState, useSlotPacks } from '../store/radioStore';
import type { OperatorStatus } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';
import { openLogbookWindow } from '../utils/windowManager';
import { addToast } from '@heroui/toast';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadioOperator');

interface RadioOperatorProps {
  operatorStatus: OperatorStatus;
}

export const RadioOperator: React.FC<RadioOperatorProps> = React.memo(({ operatorStatus }) => {
  const { t } = useTranslation('radio');
  const connection = useConnection();
  const radio = useRadioState();
  const slotPacks = useSlotPacks();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();

  // 判断当前卡片是否被选中
  const isSelected = currentOperatorId === operatorStatus.id;

  // 调试：渲染计数器
  const renderCountRef = React.useRef(0);
  renderCountRef.current++;
  
  // 调试：记录props变化
  const prevOperatorStatusRef = React.useRef(operatorStatus);
  React.useEffect(() => {
    if (prevOperatorStatusRef.current.id === operatorStatus.id) {
      const contextChanged = JSON.stringify(prevOperatorStatusRef.current.context) !== JSON.stringify(operatorStatus.context);
      
      if (contextChanged) {
        logger.debug(`Operator ${operatorStatus.id} render #${renderCountRef.current}`, {
          contextChanged,
          focusedFields: Array.from(focusedFields),
        });
      }
    }
    prevOperatorStatusRef.current = operatorStatus;
  });

  // 本地状态管理
  const [localContext, setLocalContext] = React.useState(() => {
    // 初始化时直接使用operatorStatus的值，不使用默认值
    return {
      myCall: operatorStatus.context.myCall || '',
      myGrid: operatorStatus.context.myGrid || '',
      targetCall: operatorStatus.context.targetCall || '',
      targetGrid: operatorStatus.context.targetGrid || '',
      frequency: operatorStatus.context.frequency, // 频率可选，用于无电台模式设置完整的无线电频率（Hz）
      reportSent: operatorStatus.context.reportSent ?? 0,
    };
  });

  // 报告字段的原始字符串（支持 ""、"-" 等中间态）
  const [reportSentRaw, setReportSentRaw] = React.useState(() =>
    (operatorStatus.context.reportSent ?? 0).toString()
  );

  // 频率字段的原始字符串（支持编辑中间态，失焦时 clamp）
  const [frequencyRaw, setFrequencyRaw] = React.useState(() =>
    (operatorStatus.context.frequency ?? 1500).toString()
  );

  // 展开/收起时隙内容的状态
  const [isSlotContentExpanded, setIsSlotContentExpanded] = React.useState(false);
  
  // 本地发射周期状态（用于乐观更新）
  const [localTransmitCycles, setLocalTransmitCycles] = React.useState<number[]>(() => {
    return operatorStatus.transmitCycles || [0];
  });
  
  // 防抖定时器ref
  const debounceTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  // 正在聚焦编辑的字段集合 — 聚焦期间服务端推送不会覆盖这些字段
  const [focusedFields, setFocusedFields] = React.useState<Set<string>>(new Set());

  // 冷却中的字段集合 — 失焦后短暂保护期，期间缓冲服务端推送
  const [cooldownFields, setCooldownFields] = React.useState<Set<string>>(new Set());

  // 冷却期缓冲区：存储冷却期间服务端推送的最新值
  const cooldownBufferRef = React.useRef<Record<string, string | number>>({});

  // localContext ref，供回调函数读取最新值
  const localContextRef = React.useRef(localContext);
  localContextRef.current = localContext;

  // 立即停止发射Popover状态
  const [isForceStopPopoverOpen, setIsForceStopPopoverOpen] = React.useState(false);
  // 用户已点击"立即停止"后，防止 Popover 被自动重新打开（等待服务端确认）
  const hasRequestedForceStopRef = React.useRef(false);

  // 清除强制停止请求标记：
  // - isInActivePTT 变 false（服务端确认停止）
  // - isTransmitting 变 true（用户重新开启发射开关）
  React.useEffect(() => {
    if (!operatorStatus.isInActivePTT || operatorStatus.isTransmitting) {
      hasRequestedForceStopRef.current = false;
    }
  }, [operatorStatus.isInActivePTT, operatorStatus.isTransmitting]);

  // 判断是否显示立即停止发射Popover
  // 条件：当前操作员已关闭发射开关，但其音频仍在被实际播放
  const shouldShowForceStopPopover = React.useCallback(() => {
    // 已请求停止，等待服务端确认
    if (hasRequestedForceStopRef.current) {
      return false;
    }

    // 1. 当前操作员已关闭发射开关
    if (operatorStatus.isTransmitting) {
      return false;
    }

    // 2. 该操作员的音频正在被实际播放（PTT中）
    if (!operatorStatus.isInActivePTT) {
      return false;
    }

    return true;
  }, [
    operatorStatus.isTransmitting,
    operatorStatus.isInActivePTT,
  ]);

  // 监听状态变化，自动打开/关闭Popover
  React.useEffect(() => {
    const shouldShow = shouldShowForceStopPopover();
    if (shouldShow && !isForceStopPopoverOpen) {
      logger.debug('Auto-opening force stop popover');
      setIsForceStopPopoverOpen(true);
    } else if (!shouldShow && isForceStopPopoverOpen) {
      logger.debug('Auto-closing force stop popover');
      setIsForceStopPopoverOpen(false);
    }
  }, [shouldShowForceStopPopover, isForceStopPopoverOpen]);

  // 同步服务端状态到本地
  // - 聚焦中的字段：保留本地值（用户正在输入）
  // - 冷却中的字段：写入缓冲区（不直接更新 UI，等冷却结束再应用）
  // - 其他字段：直接用服务端值
  React.useEffect(() => {
    if (operatorStatus.context && operatorStatus.context.myCall) {
      const serverCtx = operatorStatus.context;
      const fields = ['myCall', 'myGrid', 'targetCall', 'targetGrid', 'frequency', 'reportSent'] as const;
      const serverMap: Record<string, string | number> = {
        myCall: serverCtx.myCall || '',
        myGrid: serverCtx.myGrid || '',
        targetCall: serverCtx.targetCall || '',
        targetGrid: serverCtx.targetGrid || '',
        frequency: serverCtx.frequency,
        reportSent: serverCtx.reportSent ?? 0,
      };

      // 冷却中的字段：更新缓冲区
      for (const field of fields) {
        if (cooldownFields.has(field)) {
          cooldownBufferRef.current[field] = serverMap[field];
        }
      }

      setLocalContext(prevContext => {
        const newContext = { ...prevContext };
        for (const field of fields) {
          if (focusedFields.has(field) || cooldownFields.has(field)) {
            // 聚焦或冷却中 → 保留本地值
            continue;
          }
          (newContext as Record<string, string | number>)[field] = serverMap[field];
        }

        const hasChanged = fields.some(f =>
          (prevContext as Record<string, unknown>)[f] !== (newContext as Record<string, unknown>)[f]
        );

        // 同步原始字符串显示（仅非聚焦/冷却时）
        if (!focusedFields.has('reportSent') && !cooldownFields.has('reportSent')) {
          const newVal = (newContext.reportSent ?? 0).toString();
          if (reportSentRaw !== newVal) {
            setReportSentRaw(newVal);
          }
        }
        if (!focusedFields.has('frequency') && !cooldownFields.has('frequency')) {
          const newVal = (newContext.frequency ?? 1500).toString();
          if (frequencyRaw !== newVal) {
            setFrequencyRaw(newVal);
          }
        }

        return hasChanged ? newContext : prevContext;
      });
    }
  }, [operatorStatus.context, focusedFields, cooldownFields, reportSentRaw, frequencyRaw]);

  // 同步服务端transmitCycles到本地状态
  React.useEffect(() => {
    if (operatorStatus.transmitCycles) {
      setLocalTransmitCycles(operatorStatus.transmitCycles);
    }
  }, [operatorStatus.transmitCycles]);

  // 组件卸载时清理定时器
  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  // 发送用户命令
  const sendUserCommand = (command: string, args: Record<string, unknown> | string) => {
    if (connection.state.radioService) {
      connection.state.radioService.sendUserCommand(operatorStatus.id, command, args);
    }
  };

  // 发送 localContext 到服务端
  const doSendContext = React.useCallback((ctx: typeof localContext) => {
    sendUserCommand('update_context', {
      myCall: ctx.myCall,
      myGrid: ctx.myGrid,
      targetCallsign: ctx.targetCall,
      targetGrid: ctx.targetGrid,
      frequency: ctx.frequency,
      reportSent: ctx.reportSent,
      reportReceived: null,
    });
  }, [sendUserCommand]);

  // 处理上下文更新（用户每次击键）
  const handleContextUpdate = (field: string, value: string | number) => {
    const newContext = { ...localContext, [field]: value };
    setLocalContext(newContext);

    // 重置防抖
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      doSendContext(newContext);
    }, 400);
  };

  // 输入框聚焦：标记字段为受保护状态
  const handleInputFocus = React.useCallback((field: string) => {
    setFocusedFields(prev => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  }, []);

  // 输入框失焦：立即提交，进入冷却期
  const handleInputBlur = React.useCallback((field: string) => {
    // 取消防抖，立即发送
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    doSendContext(localContextRef.current);

    // 从聚焦集合移出，转入冷却集合
    setFocusedFields(prev => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
    setCooldownFields(prev => {
      const next = new Set(prev);
      next.add(field);
      return next;
    });

    // 500ms 冷却结束：将缓冲区数据应用到 UI
    setTimeout(() => {
      setCooldownFields(prev => {
        if (!prev.has(field)) return prev;
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
      // 应用缓冲区中该字段的值（如果有）
      const bufferedValue = cooldownBufferRef.current[field];
      if (bufferedValue !== undefined) {
        setLocalContext(prev => {
          if ((prev as Record<string, unknown>)[field] === bufferedValue) return prev;
          return { ...prev, [field]: bufferedValue };
        });
        // 同步原始字符串显示
        if (field === 'reportSent') {
          setReportSentRaw(bufferedValue.toString());
        } else if (field === 'frequency') {
          setFrequencyRaw(bufferedValue.toString());
        }
        delete cooldownBufferRef.current[field];
      }
    }, 500);
  }, [doSendContext]);

  // Enter 键：触发 blur → 自动走 handleInputBlur 逻辑
  const handleInputKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  }, []);

  // 处理时隙内容变化
  const handleSlotContentChange = (slot: string, content: string) => {
    sendUserCommand('set_slot_content', { slot, content });
  };

  // 处理快速状态切换
  const handleQuickStateChange = (slot: string) => {
    sendUserCommand('set_state', slot);
  };

  // 获取当前发射周期设置
  const _getCurrentTransmitCycle = () => {
    const transmitCycles = operatorStatus.transmitCycles || [0];
    
    if (transmitCycles.length === 0) {
      return 'none';
    } else if (transmitCycles.length === 2 && transmitCycles.includes(0) && transmitCycles.includes(1)) {
      return 'both';
    } else if (transmitCycles.includes(0) && transmitCycles.includes(1)) {
      return 'both';
    } else if (transmitCycles.includes(0)) {
      return '0';
    } else if (transmitCycles.includes(1)) {
      return '1';
    } else {
      return 'none';
    }
  };

  // 处理发射周期变化
  const _handleTransmitCycleChange = (keys: Selection) => {
    const selectedKey = Array.from(keys as Set<string>)[0];
    let transmitCycles: number[] = [];
    
    switch (selectedKey) {
      case 'none':
        transmitCycles = [];
        break;
      case '0':
        transmitCycles = [0];
        break;
      case '1':
        transmitCycles = [1];
        break;
      case 'both':
        transmitCycles = [0, 1];
        break;
      default:
        transmitCycles = [0];
    }
    
    sendUserCommand('set_transmit_cycles', { transmitCycles });
  };

  // 获取当前发射内容
  const getCurrentTransmissionContent = () => {
    if (operatorStatus.slots && operatorStatus.currentSlot) {
      return operatorStatus.slots[operatorStatus.currentSlot as keyof typeof operatorStatus.slots] || '';
    }
    return '';
  };

  // 处理立即停止发射：移除当前操作员的音频并重混音
  const handleForceStop = () => {
    if (connection.state.radioService) {
      hasRequestedForceStopRef.current = true;
      connection.state.radioService.removeOperatorFromTransmission(operatorStatus.id);
      setIsForceStopPopoverOpen(false);
    }
  };

  // 获取进度条颜色 - 颜色变化用 CSS transition 平滑过渡
  const getProgressColor = (): string => {
    if (!operatorStatus.cycleInfo) {
      return 'var(--ft8-cycle-even-bg)';
    }

    const { currentCycle, isTransmitCycle } = operatorStatus.cycleInfo;
    const isActuallyTransmitting = operatorStatus.isTransmitting && isTransmitCycle;

    if (isActuallyTransmitting) {
      return 'hsl(var(--heroui-danger) / 0.15)';
    }

    const isEvenCycle = CycleUtils.isEvenCycle(currentCycle);
    return isEvenCycle ? 'var(--ft8-cycle-even-bg)' : 'var(--ft8-cycle-odd-bg)';
  };

  // 进度条动画样式 - 只在周期变化时重新计算，避免发射状态变化时重新触发动画
  const progressAnimation = React.useMemo((): React.CSSProperties => {
    if (!operatorStatus.cycleInfo || !radio.state.currentMode) {
      return { animation: 'none' };
    }

    const { cycleProgress } = operatorStatus.cycleInfo;
    const cycleDurationMs = radio.state.currentMode.slotMs;

    // 超过120%表示服务端可能掉线，显示空条
    if (cycleProgress > 1.2) {
      return { animation: 'none' };
    }

    // 计算动画参数：遮罩从 (100% - 当前进度) 缩小到 0%
    const remainingMs = Math.max(0, cycleDurationMs * (1 - cycleProgress));
    const maskStartPercent = Math.max(0, 100 - cycleProgress * 100);

    return {
      animation: `progress-bar ${remainingMs}ms linear forwards`,
      // @ts-expect-error CSS custom property for animation start position
      '--progress-start': `${maskStartPercent}%`,
    };
  }, [operatorStatus.cycleInfo?.currentCycle, radio.state.currentMode?.slotMs]);

  // 选择空闲频率
  const pickIdleFrequency = () => {
    const mode = radio.state.currentMode;
    if (!mode) {
      addToast({
        title: t('operator.cannotPickFreq'),
        description: t('operator.cannotPickFreqDesc'),
        color: 'warning'
      });
      return;
    }

    const transmitCycles = localTransmitCycles && localTransmitCycles.length > 0 ? localTransmitCycles : [0];

    const candidates = [...(slotPacks.state.slotPacks || [])]
      .filter(sp => {
        const cycleMatch = CycleUtils.isOperatorTransmitCycleFromMs(transmitCycles, sp.startMs, mode.slotMs);
        return cycleMatch && sp.frames && sp.frames.length > 0;
      })
      .sort((a, b) => b.endMs - a.endMs);

    if (candidates.length === 0) {
      addToast({
        title: t('operator.noSlot'),
        description: t('operator.noSlotDesc'),
        color: 'warning'
      });
      return;
    }

    const latest = candidates[0];
    const freqs = [0, 3000];  // 默认添加边界值
    freqs.push(...latest.frames.map(f => f.freq).filter(f => Number.isFinite(f)));
    freqs.sort((a, b) => a - b);

    let maxGap = -1;
    let midFreq = freqs[0];
    for (let i = 0; i < freqs.length - 1; i++) {
      const gap = freqs[i + 1] - freqs[i];
      if (gap > maxGap) {
        maxGap = gap;
        midFreq = Math.round(freqs[i] + gap / 2);
      }
    }

    if (!Number.isFinite(midFreq)) {
      addToast({
        title: t('operator.calcFailed'),
        description: t('operator.calcFailedDesc'),
        color: 'danger'
      });
      return;
    }

    // 按钮触发：立即更新本地 + 立即发送 + 冷却保护
    const clampedFreq = Math.max(1, Math.min(3000, midFreq));
    setFrequencyRaw(clampedFreq.toString());
    const newContext = { ...localContext, frequency: clampedFreq };
    setLocalContext(newContext);
    // 取消防抖，立即发送
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    doSendContext(newContext);
    // 进入冷却保护，防止服务端旧值覆盖
    delete cooldownBufferRef.current['frequency'];
    setCooldownFields(prev => {
      const next = new Set(prev);
      next.add('frequency');
      return next;
    });
    setTimeout(() => {
      setCooldownFields(prev => {
        if (!prev.has('frequency')) return prev;
        const next = new Set(prev);
        next.delete('frequency');
        return next;
      });
      const buffered = cooldownBufferRef.current['frequency'];
      if (buffered !== undefined) {
        setLocalContext(prev => {
          if (prev.frequency === buffered) return prev;
          return { ...prev, frequency: buffered as number };
        });
        setFrequencyRaw(buffered.toString());
        delete cooldownBufferRef.current['frequency'];
      }
    }, 500);
    addToast({
      title: t('operator.freqSelected'),
      description: `${midFreq} Hz`,
      color: 'success'
    });
  };

  return (
    <div 
      className="border border-divider rounded-lg overflow-hidden transition-all duration-300 ease-in-out cursor-default select-none"
      style={{
        transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        boxShadow: operators.length > 1 && currentOperatorId === operatorStatus.id ? '0 0 0 2px rgba(255, 166, 0, 0.5)' : 'none'
      }}
      onClick={() => {
        setCurrentOperatorId(operatorStatus.id);
      }}
    >
      {/* 上半部分 - 进度条背景 */}
      <div className="relative h-12 p-4">
        {/* 进度条颜色层 - 仅在解码时显示 */}
        {radio.state.isDecoding && (
          <div
            className="absolute inset-0 transition-colors duration-200"
            style={{ backgroundColor: getProgressColor() }}
          />
        )}
        {/* 进度条遮罩层 - 仅在解码时显示 */}
        {radio.state.isDecoding && (
          <div
            key={operatorStatus.cycleInfo?.currentCycle ?? 'idle'}
            className="absolute inset-0 progress-bar-mask"
            style={progressAnimation}
          />
        )}
        <div className="relative flex items-center justify-between h-full">
          {/* 左侧 - 发射内容或监听状态 */}
          <div className="flex-1">
            {(() => {
              // 未在解码时，显示操作员呼号
              if (!radio.state.isDecoding) {
                return (
                  <div className="text-foreground opacity-65 font-bold text-lg">
                    {operatorStatus.context.myCall || 'N0CALL'}
                  </div>
                );
              }

              // 解码中但无周期信息
              if (!operatorStatus.cycleInfo) {
                return (
                  <div className="text-foreground opacity-65 font-bold text-lg">
                    {t('operator.listening')}
                  </div>
                );
              }

              const { isTransmitCycle } = operatorStatus.cycleInfo;
              const isActuallyTransmitting = operatorStatus.isTransmitting && isTransmitCycle;

              return isActuallyTransmitting ? (
                <div className="font-bold font-mono text-lg text-danger">
                  {getCurrentTransmissionContent() || t('operator.preparingTx')}
                </div>
              ) : (
                <div className="text-foreground opacity-65 font-bold font-mono text-lg">
                  {t('operator.listening')}
                </div>
              );
            })()}
          </div>
          
          {/* 右侧 - 通联日志按钮和发射开关 */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="flat"
              onPress={() => openLogbookWindow({
                operatorId: operatorStatus.id,
                logBookId: operatorStatus.context.myCall
              })}
              className="h-8 px-2"
              title={t('operator.viewLog')}
              aria-label={t('operator.viewLog')}
              startContent={<FontAwesomeIcon icon={faBook} />}
            >
              {t('operator.log')}
            </Button>
            <span className="text-sm text-default-600">{t('control.ptt')}</span>
            <Popover
              isOpen={isForceStopPopoverOpen}
              onOpenChange={setIsForceStopPopoverOpen}
              placement="top"
              offset={10}
            >
              <PopoverTrigger>
                <Switch
                  isSelected={operatorStatus.isTransmitting}
                  onValueChange={(isSelected) => {
                    logger.debug('Switch value changed:', { isSelected, operatorId: operatorStatus.id });
                    if (connection.state.radioService) {
                      if (isSelected) {
                        connection.state.radioService.startOperator(operatorStatus.id);
                      } else {
                        logger.debug('Switch off, checking if force stop popover needed');
                        connection.state.radioService.stopOperator(operatorStatus.id);
                      }
                    }
                  }}
                  size="sm"
                  color="danger"
                  isDisabled={!connection.state.isConnected}
                  aria-label={t('operator.toggleTx')}
                />
              </PopoverTrigger>
              <PopoverContent>
                <div className="px-3 py-2">
                  <Button
                    size="sm"
                    color="danger"
                    onPress={handleForceStop}
                    fullWidth
                  >
                    {t('operator.forceStop')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
      
      {/* 分割线 - 随下半部分一起显示/隐藏 */}
      <div
        className={`border-divider transition-opacity duration-[250ms] ${
          isSelected ? 'border-t opacity-100' : 'border-t-0 opacity-0'
        }`}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)'
        }}
      ></div>

      {/* 下半部分 - 带展开/收起动画 */}
      <div
        className={`overflow-hidden transition-all duration-[250ms] ${
          isSelected ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'
        }`}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)'
        }}
      >
        <div className="p-4 flex flex-col gap-3">
        {/* 第一行 - 发射周期和发射槽位选择 */}
        <div className="flex gap-2 -my-1">
          <div className="flex items-center gap-0">
            <span className="text-default-500 text-sm">{t('operator.txCycle')}:</span>
            <Button
              size="sm"
              variant="light"
                              className="h-auto p-1 min-w-0 bg-transparent hover:bg-content2 px-2 rounded-md"
              isDisabled={!connection.state.isConnected}
              aria-label={t('operator.toggleTxCycle')}
              onPress={() => {
                // 获取当前本地设置的发射周期
                const currentTransmitCycles = localTransmitCycles;
                let newTransmitCycles: number[] = [];
                
                // 根据当前设置切换到另一种周期
                if (currentTransmitCycles.includes(0) && !currentTransmitCycles.includes(1)) {
                  // 当前设置为偶数周期，切换到奇数周期
                  newTransmitCycles = [1];
                } else {
                  // 当前设置为奇数周期或其他情况，切换到偶数周期
                  newTransmitCycles = [0];
                }
                
                // 立即更新本地状态（乐观更新）
                setLocalTransmitCycles(newTransmitCycles);
                
                // 发送到服务端
                sendUserCommand('set_transmit_cycles', { transmitCycles: newTransmitCycles });
              }}
            >
              <div className="flex items-center gap-1">
                {(() => {
                  // 使用本地发射周期状态
                  const transmitCycles = localTransmitCycles;
                  const mode = radio.state.currentMode;
                  let displayText = "";
                  let dotColor = "#9CA3AF";
                  
                  // 根据用户设置的发射周期决定显示内容
                  if (transmitCycles.includes(0) && !transmitCycles.includes(1)) {
                    // 只在偶数周期发射
                    if (mode?.name === 'FT8') {
                      displayText = "00/30";
                    } else {
                      displayText = t('operator.evenCycle');
                    }
                    dotColor = "#5EC56F"; // 绿色
                  } else if (transmitCycles.includes(1) && !transmitCycles.includes(0)) {
                    // 只在奇数周期发射
                    if (mode?.name === 'FT8') {
                      displayText = "15/45";
                    } else {
                      displayText = t('operator.oddCycle');
                    }
                    dotColor = "#FFCD94"; // 黄色
                  } else {
                    // 默认显示偶数周期
                    if (mode?.name === 'FT8') {
                      displayText = "00/30";
                    } else {
                      displayText = t('operator.evenCycle');
                    }
                    dotColor = "#5EC56F";
                  }
                  
                  return (
                    <>
                      <div 
                        className="w-2 h-2 rounded-full" 
                        style={{ backgroundColor: dotColor }}
                      ></div>
                      <span className="text-sm font-mono text-foreground">{displayText}</span>
                      <FontAwesomeIcon icon={faRepeat} className="ml-1 text-default-400 text-xs" />
                    </>
                  );
                })()}
              </div>
            </Button>
          </div>
          
          <div className="flex items-center gap-0">
            <Select
              selectedKeys={[operatorStatus.currentSlot || 'TX6']}
              onSelectionChange={(keys) => {
                const slot = Array.from(keys)[0] as string;
                if (slot && connection.state.radioService) {
                  connection.state.radioService.sendUserCommand(
                    operatorStatus.id,
                    'set_state',
                    slot
                  );
                }
              }}
              size="sm"
              variant="bordered"
              className="w-auto min-w-[200px]"
              classNames={{
                trigger: "bg-transparent border-none shadow-none p-1 pl-2 h-auto min-h-0 rounded-md data-[hover=true]:bg-content2",
                value: "text-sm font-mono text-foreground p-0",
                selectorIcon: "text-default-400 text-xs",
                popoverContent: "min-w-[260px]",
              }}
              isDisabled={!connection.state.isConnected}
              aria-label={t('operator.selectSlot')}
              renderValue={(items) => {
                const item = items[0];
                if (!item || !operatorStatus.slots) return String(item?.key || 'TX6');

                // 显示为"TXN: 内容"格式
                const slotKey = String(item.key);
                const slotContent = operatorStatus.slots[item.key as keyof typeof operatorStatus.slots];
                return slotContent ? slotContent : slotKey;
              }}
            >
              {operatorStatus.strategy.availableSlots.map((slot) => {
                const slotContent = operatorStatus.slots?.[slot as keyof typeof operatorStatus.slots];
                const displayText = slotContent ? `${slot}: ${slotContent}` : slot;
                return (
                  <SelectItem key={slot}>
                    {displayText}
                  </SelectItem>
                );
              })}
            </Select>

            {/* 重置按钮 - 仅在非TX6状态下显示 */}
            {operatorStatus.currentSlot !== 'TX6' && (
              <Tooltip content={t('operator.resetToCQ')} placement="top" offset={6}>
                <Button
                  size="sm"
                  variant="light"
                  isIconOnly
                  onPress={() => {
                    if (connection.state.radioService) {
                      // 第1步：清理通联上下文
                      connection.state.radioService.sendUserCommand(
                        operatorStatus.id,
                        'update_context',
                        {
                          targetCallsign: '',     // 清除目标呼号
                          targetGrid: '',          // 清除目标网格
                          reportSent: 0,           // 重置发送报告
                          reportReceived: 0,       // 重置接收报告
                        }
                      );

                      // 第2步：切换到 TX6 槽位
                      connection.state.radioService.sendUserCommand(
                        operatorStatus.id,
                        'set_state',
                        'TX6'
                      );
                    }
                  }}
                  className="h-auto p-2 min-w-0 w-auto"
                  aria-label={t('operator.resetToCQ')}
                  isDisabled={!connection.state.isConnected}
                >
                  <FontAwesomeIcon icon={faRotateLeft} className="text-default-400" />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
        
        {/* 第二行 - Context输入和展开按钮 */}
        <div className="flex gap-3 items-end">
          <Input
            startContent={
              <div className="flex items-center">
                <span className="text-sm text-default-500 whitespace-nowrap">{t('operator.target')}</span>
                <div className="w-px h-4 bg-divider mx-2"></div>
              </div>
            }
            value={localContext.targetCall}
            onChange={(e) => handleContextUpdate('targetCall', e.target.value)}
            onFocus={() => handleInputFocus('targetCall')}
            onBlur={() => handleInputBlur('targetCall')}
            onKeyDown={handleInputKeyDown}
            size="sm"
            variant="flat"
            placeholder={t('common:status.none')}
            isDisabled={!connection.state.isConnected}
            className="flex-1"
            aria-label={t('operator.targetCallsign')}
          />
          <Input
            startContent={
              <div className="flex items-center">
                <span className="text-sm text-default-500 whitespace-nowrap">{t('operator.report')}</span>
                <div className="w-px h-4 bg-divider mx-2"></div>
              </div>
            }
            value={reportSentRaw}
            onChange={(e) => {
              const raw = e.target.value;
              // 只允许可选负号 + 数字
              if (raw !== '' && raw !== '-' && !/^-?\d+$/.test(raw)) return;
              setReportSentRaw(raw);
              // 中间态（空或单独负号）只更新显示，不触发防抖上报
              const num = parseInt(raw);
              if (!isNaN(num)) {
                handleContextUpdate('reportSent', num);
              }
            }}
            onFocus={() => handleInputFocus('reportSent')}
            onBlur={() => {
              // 失焦时修正中间态
              const num = parseInt(reportSentRaw);
              if (isNaN(num)) {
                setReportSentRaw('0');
                handleContextUpdate('reportSent', 0);
              }
              handleInputBlur('reportSent');
            }}
            onKeyDown={handleInputKeyDown}
            size="sm"
            variant="flat"
            placeholder="0"
            isDisabled={!connection.state.isConnected}
            className="flex-1"
            aria-label={t('operator.txReport')}
          />
          <Input
            startContent={
              <div className="flex items-center">
                <span className="text-sm text-default-500 whitespace-nowrap">{t('control.frequency')}</span>
                <div className="w-px h-4 bg-divider mx-2"></div>
              </div>
            }
            endContent={
              <Tooltip content={t('operator.autoPickFreq')} placement="top" offset={6}>
                <Button
                  size="sm"
                  variant="light"
                  isIconOnly
                  radius="sm"
                  className="min-w-0 h-6 w-6 text-default-400 hover:text-foreground"
                  onPress={pickIdleFrequency}
                  isDisabled={!connection.state.isConnected}
                  aria-label={t('operator.autoFrequency')}
                >
                  <FontAwesomeIcon icon={faWandMagicSparkles} />
                </Button>
              </Tooltip>
            }
            value={frequencyRaw}
            onChange={(e) => {
              const raw = e.target.value;
              // 只允许正整数
              if (raw !== '' && !/^\d+$/.test(raw)) return;
              setFrequencyRaw(raw);
              const num = parseInt(raw);
              if (!isNaN(num) && num > 0) {
                handleContextUpdate('frequency', num);
              }
            }}
            onFocus={() => handleInputFocus('frequency')}
            onBlur={() => {
              // 失焦时校验并 clamp
              let num = parseInt(frequencyRaw);
              if (isNaN(num) || num < 1) num = 1;
              if (num > 3000) num = 3000;
              setFrequencyRaw(num.toString());
              handleContextUpdate('frequency', num);
              handleInputBlur('frequency');
            }}
            onKeyDown={handleInputKeyDown}
            size="sm"
            variant="flat"
            isDisabled={!connection.state.isConnected}
            className="flex-1"
            aria-label={t('control.frequency')}
          />
          
          {/* 展开/收起按钮 */}
          <Button
            size="sm"
            variant="light"
            onPress={() => setIsSlotContentExpanded(!isSlotContentExpanded)}
            className="text-default-400 text-sm min-w-0 px-3 transition-all duration-200 hover:bg-content2"
            style={{
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)'
            }}
            aria-label={isSlotContentExpanded ? t('operator.collapse') : t('operator.expand')}
            startContent={
              <span 
                className={`transition-transform duration-300 ${isSlotContentExpanded ? 'rotate-180' : 'rotate-0'}`}
                style={{
                  transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
                }}
              >
                ▼
              </span>
            }
          >
            {isSlotContentExpanded ? t('operator.collapse') : t('operator.expand')}
          </Button>
        </div>
        
        {/* 时隙内容（展开时显示） */}
        <div 
          className={`overflow-hidden transition-all duration-[400ms] ${
            isSlotContentExpanded ? 'max-h-[230px] opacity-100' : 'max-h-0 opacity-0 -mb-3'
          }`}
          style={{
            transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)'
          }}
        >
          {operatorStatus.slots && (
            <div className="space-y-2 py-1 bg-content2 overflow-hidden rounded-lg">
              <div className="grid grid-cols-1 gap-0 text-xs">
                {Object.entries(operatorStatus.slots).map(([slot, content]) => (
                  <div 
                    key={slot} 
                    className={`p-2 py-1 transition-colors duration-200 ${
                      operatorStatus.currentSlot === slot 
                        ? 'bg-primary-50 border-primary-200' 
                        : 'bg-content2 border-divider'
                    }`}
                    style={{
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)'
                    }}
                  >
                    <div className="flex px-1 items-center gap-2">
                      <span className="text-sm font-medium text-default-600 min-w-[30px]">{slot}:</span>
                      <Input
                        value={content || ''}
                        onChange={(e) => handleSlotContentChange(slot, e.target.value)}
                        size="sm"
                        variant="bordered"
                        className="flex-1 text-sm"
                        classNames={{
                          input: "font-mono text-sm",
                          inputWrapper: "h-7 min-h-7"
                        }}
                        placeholder={t('operator.emptySlot')}
                        isDisabled={!connection.state.isConnected}
                        aria-label={t('operator.slotContent', { slot })}
                      />
                      <Button
                        size="sm"
                        color={operatorStatus.currentSlot === slot ? "primary" : "default"}
                        variant={operatorStatus.currentSlot === slot ? "solid" : "bordered"}
                        isIconOnly
                        onClick={() => handleQuickStateChange(slot)}
                        className="h-7 w-7 min-w-7 transition-all duration-200"
                        style={{
                          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)'
                        }}
                        isDisabled={!connection.state.isConnected}
                        title={t('operator.switchToSlot', { slot })}
                        aria-label={t('operator.switchToSlot', { slot })}
                      >
                        {operatorStatus.currentSlot === slot ? "●" : "○"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  const prev = prevProps.operatorStatus;
  const next = nextProps.operatorStatus;
  
  if (prev.id !== next.id ||
      prev.isActive !== next.isActive ||
      prev.isTransmitting !== next.isTransmitting ||
      prev.currentSlot !== next.currentSlot) {
    return false;
  }
  
  if (JSON.stringify(prev.context) !== JSON.stringify(next.context)) {
    return false;
  }
  
  if (JSON.stringify(prev.slots) !== JSON.stringify(next.slots)) {
    return false;
  }
  
  if (prev.cycleInfo && next.cycleInfo) {
    if (prev.cycleInfo.currentCycle !== next.cycleInfo.currentCycle ||
        prev.cycleInfo.isTransmitCycle !== next.cycleInfo.isTransmitCycle) {
      return false;
    }
  } else if (prev.cycleInfo !== next.cycleInfo) {
    return false;
  }
  
  if (JSON.stringify(prev.transmitCycles) !== JSON.stringify(next.transmitCycles)) {
    return false;
  }
  
  return true;
}); 
