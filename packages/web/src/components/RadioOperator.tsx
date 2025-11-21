import * as React from 'react';
import { Select, SelectItem, Input, Button, Switch, Selection, Tooltip, Popover, PopoverTrigger, PopoverContent } from "@heroui/react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faWandMagicSparkles, faRepeat, faBook, faRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { useConnection, useCurrentOperatorId, useOperators, useRadioState, useSlotPacks } from '../store/radioStore';
import type { OperatorStatus } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';
import { openLogbookWindow } from '../utils/windowManager';
import { addToast } from '@heroui/toast';

interface RadioOperatorProps {
  operatorStatus: OperatorStatus;
}

export const RadioOperator: React.FC<RadioOperatorProps> = React.memo(({ operatorStatus }) => {
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
        console.log(`🔄 [RadioOperator ${operatorStatus.id}] 渲染 #${renderCountRef.current}`, {
          contextChanged,
          editingFields: Array.from(editingFields),
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

  // 展开/收起时隙内容的状态
  const [isSlotContentExpanded, setIsSlotContentExpanded] = React.useState(false);
  
  // 本地发射周期状态（用于乐观更新）
  const [localTransmitCycles, setLocalTransmitCycles] = React.useState<number[]>(() => {
    return operatorStatus.transmitCycles || [0];
  });
  
  // 防抖定时器ref
  const debounceTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  
  // 标记正在编辑的字段（避免服务端覆盖特定字段）
  const [editingFields, setEditingFields] = React.useState<Set<string>>(new Set());

  // 立即停止发射Popover状态
  const [isForceStopPopoverOpen, setIsForceStopPopoverOpen] = React.useState(false);

  // 判断是否显示立即停止发射Popover
  const shouldShowForceStopPopover = React.useCallback(() => {
    const checks = {
      operatorTransmitting: operatorStatus.isTransmitting,
      pttActive: radio.state.pttStatus?.isTransmitting,
      inTransmitCycle: operatorStatus.cycleInfo?.isTransmitCycle,
      pttOperatorIds: radio.state.pttStatus?.operatorIds || [],
      currentOperatorId: operatorStatus.id
    };

    console.log('🔍 [ForceStop] 检查条件:', checks);

    // 1. 当前操作员已关闭发射开关
    if (operatorStatus.isTransmitting) {
      console.log('🔍 [ForceStop] 操作员还在发射，不显示');
      return false;
    }

    // 2. PTT正在激活
    if (!radio.state.pttStatus?.isTransmitting) {
      console.log('🔍 [ForceStop] PTT未激活，不显示');
      return false;
    }

    // 3. 当前在发射周期
    if (!operatorStatus.cycleInfo?.isTransmitCycle) {
      console.log('🔍 [ForceStop] 不在发射周期，不显示');
      return false;
    }

    // 4. 检查PTT状态中的操作员列表
    const pttStatus = radio.state.pttStatus;
    if (!pttStatus) {
      console.log('🔍 [ForceStop] PTT状态不存在，不显示');
      return false;
    }

    // 5. 如果PTT状态中还有其他操作员,不显示(说明有其他操作员在发射)
    const otherOperators = pttStatus.operatorIds?.filter(id => id !== operatorStatus.id) || [];
    if (otherOperators.length > 0) {
      console.log('🔍 [ForceStop] 其他操作员在发射，不显示:', otherOperators);
      return false;
    }

    console.log('✅ [ForceStop] 所有条件满足，应该显示Popover');
    return true;
  }, [
    operatorStatus.isTransmitting,
    operatorStatus.cycleInfo?.isTransmitCycle,
    operatorStatus.id,
    radio.state.pttStatus
  ]);

  // 监听状态变化，自动打开/关闭Popover
  React.useEffect(() => {
    const shouldShow = shouldShowForceStopPopover();
    if (shouldShow && !isForceStopPopoverOpen) {
      console.log('✅ [ForceStop] 自动打开Popover');
      setIsForceStopPopoverOpen(true);
    } else if (!shouldShow && isForceStopPopoverOpen) {
      console.log('❌ [ForceStop] 自动关闭Popover');
      setIsForceStopPopoverOpen(false);
    }
  }, [shouldShowForceStopPopover, isForceStopPopoverOpen]);

  // 同步props到本地状态
  React.useEffect(() => {
    // 确保operatorStatus.context存在且数据完整
    if (operatorStatus.context && operatorStatus.context.myCall) {
      // 只更新非编辑状态的字段
      setLocalContext(prevContext => {
        const newContext = {
          myCall: editingFields.has('myCall') ? prevContext.myCall : (operatorStatus.context.myCall || ''),
          myGrid: editingFields.has('myGrid') ? prevContext.myGrid : (operatorStatus.context.myGrid || ''),
          targetCall: editingFields.has('targetCall') ? prevContext.targetCall : (operatorStatus.context.targetCall || ''),
          targetGrid: editingFields.has('targetGrid') ? prevContext.targetGrid : (operatorStatus.context.targetGrid || ''),
          frequency: editingFields.has('frequency') ? prevContext.frequency : operatorStatus.context.frequency,
          reportSent: editingFields.has('reportSent') ? prevContext.reportSent : (operatorStatus.context.reportSent ?? 0),
        };

        // 深度对比：只有在数据实际变化时才更新状态
        // 这防止了因服务端推送相同值导致的不必要重新渲染
        const hasChanged =
          prevContext.myCall !== newContext.myCall ||
          prevContext.myGrid !== newContext.myGrid ||
          prevContext.targetCall !== newContext.targetCall ||
          prevContext.targetGrid !== newContext.targetGrid ||
          prevContext.frequency !== newContext.frequency ||
          prevContext.reportSent !== newContext.reportSent;

        // 如果没有变化，返回原对象引用，避免触发下游重新渲染
        if (!hasChanged) {
          return prevContext;
        }

        // 有变化时，返回新对象
        return newContext;
      });
    }
  }, [operatorStatus.context, editingFields]);

  // 同步服务端transmitCycles到本地状态
  React.useEffect(() => {
    if (operatorStatus.transmitCycles) {
      setLocalTransmitCycles(operatorStatus.transmitCycles);
    }
  }, [operatorStatus.transmitCycles]);

  // 组件卸载时清理防抖定时器
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

  // 处理上下文更新
  const handleContextUpdate = (field: string, value: string | number) => {
    // 立即更新本地状态
    const newContext = { ...localContext, [field]: value };
    setLocalContext(newContext);
    
    // 标记该字段正在编辑
    setEditingFields(prev => new Set(prev).add(field));
    
    // 清除之前的防抖定时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    // 设置新的防抖定时器，200ms后同步到服务端（减少延迟）
    debounceTimerRef.current = setTimeout(() => {
      // 发送update_context命令，包含所有相关字段
      sendUserCommand('update_context', {
        myCall: newContext.myCall,
        myGrid: newContext.myGrid,
        targetCallsign: newContext.targetCall,
        targetGrid: newContext.targetGrid,
        frequency: newContext.frequency,
        reportSent: newContext.reportSent,
        reportReceived: null,
      });

      // 延迟清除编辑标记，等待服务端推送状态更新（约100ms）
      // 这避免了在服务端推送到达前过早清除标记导致的状态闪烁
      setTimeout(() => {
        setEditingFields(prev => {
          const newSet = new Set(prev);
          newSet.delete(field);
          return newSet;
        });
      }, 150); // 给服务端处理和推送留出时间窗口
    }, 200); // 减少防抖时间从500ms到200ms
  };

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

  // 处理立即停止发射
  const handleForceStop = () => {
    if (connection.state.radioService) {
      connection.state.radioService.forceStopTransmission();
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatorStatus.cycleInfo?.currentCycle, radio.state.currentMode?.slotMs]);

  // 选择空闲频率
  const pickIdleFrequency = () => {
    const mode = radio.state.currentMode;
    if (!mode) {
      addToast({
        title: '无法选择频率',
        description: '当前未获取到模式信息，请稍后重试。',
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
        title: '未找到可用时隙',
        description: '没有与当前发射周期类型一致的解码数据。请先取消发射，等待接收到该周期类型的通联消息后再尝试。',
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
        title: '计算失败',
        description: '无法计算空闲频率，请稍后重试。',
        color: 'danger'
      });
      return;
    }

    handleContextUpdate('frequency', midFreq);
    addToast({
      title: '已选择空闲频率',
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
        {/* 进度条颜色层 - 颜色变化用 transition 平滑过渡 */}
        <div
          className="absolute inset-0 transition-colors duration-200"
          style={{ backgroundColor: getProgressColor() }}
        />
        {/* 进度条遮罩层 - 从右侧遮盖，宽度动画控制可见进度 */}
        <div
          key={operatorStatus.cycleInfo?.currentCycle ?? 'idle'}
          className="absolute inset-0 progress-bar-mask"
          style={progressAnimation}
        />
        <div className="relative flex items-center justify-between h-full">
          {/* 左侧 - 发射内容或监听状态 */}
          <div className="flex-1">
            {(() => {
              // 完全依赖服务端推送的状态
              if (!operatorStatus.cycleInfo) {
                return (
                  <div className="text-foreground opacity-65 font-bold text-lg">
                    监听中...
                  </div>
                );
              }
              
              const { isTransmitCycle } = operatorStatus.cycleInfo;
              const isActuallyTransmitting = operatorStatus.isTransmitting && isTransmitCycle;
              
              return isActuallyTransmitting ? (
                <div className="font-bold font-mono text-lg text-danger">
                  {getCurrentTransmissionContent() || '准备发射...'}
                </div>
              ) : (
                <div className="text-foreground opacity-65 font-bold font-mono text-lg">
                  监听中...
                </div>
              );
            })()}
          </div>
          
          {/* 右侧 - 通联日志按钮和发射开关 */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="light"
              isIconOnly
              onPress={() => openLogbookWindow({ 
                operatorId: operatorStatus.id,
                logBookId: operatorStatus.context.myCall
              })}
              className="h-8 w-8 min-w-8"
              title="查看通联日志"
              aria-label="查看通联日志"
            >
              <FontAwesomeIcon icon={faBook} className="text-default-600" />
            </Button>
            <span className="text-sm text-default-600">发射</span>
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
                    console.log('🔄 [Switch] 值变化:', { isSelected, operatorId: operatorStatus.id });
                    if (connection.state.radioService) {
                      if (isSelected) {
                        connection.state.radioService.startOperator(operatorStatus.id);
                      } else {
                        console.log('🛑 [Switch] 关闭发射，检查是否需要显示Popover');
                        connection.state.radioService.stopOperator(operatorStatus.id);
                      }
                    }
                  }}
                  size="sm"
                  color="danger"
                  isDisabled={!connection.state.isConnected}
                  aria-label="切换发射状态"
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
                    立即停止发射
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
            <span className="text-default-500 text-sm">发射周期:</span>
            <Button
              size="sm"
              variant="light"
                              className="h-auto p-1 min-w-0 bg-transparent hover:bg-content2 px-2 rounded-md"
              isDisabled={!connection.state.isConnected}
              aria-label="切换发射周期"
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
                      displayText = "偶数周期";
                    }
                    dotColor = "#5EC56F"; // 绿色
                  } else if (transmitCycles.includes(1) && !transmitCycles.includes(0)) {
                    // 只在奇数周期发射
                    if (mode?.name === 'FT8') {
                      displayText = "15/45";
                    } else {
                      displayText = "奇数周期";
                    }
                    dotColor = "#FFCD94"; // 黄色
                  } else {
                    // 默认显示偶数周期
                    if (mode?.name === 'FT8') {
                      displayText = "00/30";
                    } else {
                      displayText = "偶数周期";
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
              aria-label="选择当前时隙"
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
              <Tooltip content="重置到CQ" placement="top" offset={6}>
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
                  aria-label="重置到CQ"
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
                <span className="text-sm text-default-500 whitespace-nowrap">目标</span>
                <div className="w-px h-4 bg-divider mx-2"></div>
              </div>
            }
            value={localContext.targetCall}
            onChange={(e) => handleContextUpdate('targetCall', e.target.value)}
            size="sm"
            variant="flat"
            placeholder="暂无"
            isDisabled={!connection.state.isConnected}
            className="flex-1"
            aria-label="目标呼号"
          />
          <Input
            startContent={
              <div className="flex items-center">
                <span className="text-sm text-default-500 whitespace-nowrap">报告</span>
                <div className="w-px h-4 bg-divider mx-2"></div>
              </div>
            }
            type="number"
            value={localContext.reportSent.toString()}
            onChange={(e) => {
              const value = e.target.value;
              const numValue = value === '' ? 0 : parseInt(value);
              if (!isNaN(numValue)) {
                handleContextUpdate('reportSent', numValue);
              }
            }}
            size="sm"
            variant="flat"
            placeholder="0"
            isDisabled={!connection.state.isConnected}
            className="flex-1"
            aria-label="发送报告"
          />
          <Input
            startContent={
              <div className="flex items-center">
                <span className="text-sm text-default-500 whitespace-nowrap">频率</span>
                <div className="w-px h-4 bg-divider mx-2"></div>
              </div>
            }
            endContent={
              <Tooltip content="自动选择空闲频率" placement="top" offset={6}>
                <Button
                  size="sm"
                  variant="light"
                  isIconOnly
                  radius="sm"
                  className="min-w-0 h-6 w-6 text-default-400 hover:text-foreground"
                  onPress={pickIdleFrequency}
                  isDisabled={!connection.state.isConnected}
                  aria-label="自动选择空闲频率"
                >
                  <FontAwesomeIcon icon={faWandMagicSparkles} />
                </Button>
              </Tooltip>
            }
            type="number"
            value={localContext?.frequency?.toString()}
            onChange={(e) => handleContextUpdate('frequency', parseInt(e.target.value) || 1550)}
            size="sm"
            variant="flat"
            isDisabled={!connection.state.isConnected}
            className="flex-1"
            aria-label="频率"
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
            aria-label={isSlotContentExpanded ? "收起时隙内容" : "展开时隙内容"}
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
            {isSlotContentExpanded ? '收起' : '展开'}
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
                        placeholder="(空)"
                        isDisabled={!connection.state.isConnected}
                        aria-label={`${slot}时隙内容`}
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
                        title={`切换到${slot}`}
                        aria-label={`切换到${slot}`}
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
