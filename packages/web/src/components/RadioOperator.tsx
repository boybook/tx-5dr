import * as React from 'react';
import { Card, CardBody, Select, SelectItem, Input, Progress, Button, Chip, Switch, Selection, Tooltip } from "@heroui/react";
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

const SLOT_OPTIONS = ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'];

export const RadioOperator: React.FC<RadioOperatorProps> = React.memo(({ operatorStatus }) => {
  const connection = useConnection();
  const radio = useRadioState();
  const slotPacks = useSlotPacks();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();
  
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

  // 实时进度状态
  const [realtimeProgress, setRealtimeProgress] = React.useState(0);
  
  // 展开/收起时隙内容的状态
  const [isSlotContentExpanded, setIsSlotContentExpanded] = React.useState(false);
  
  // 本地发射周期状态（用于乐观更新）
  const [localTransmitCycles, setLocalTransmitCycles] = React.useState<number[]>(() => {
    return operatorStatus.transmitCycles || [0];
  });
  
  // 用于存储周期信息的ref（仅用于进度条动画）
  const cycleInfoRef = React.useRef<{
    cycleStartMs: number;
    cycleDurationMs: number;
  } | null>(null);

  // 动画控制ref
  const animationFrameRef = React.useRef<number | null>(null);
  
  // 防抖定时器ref
  const debounceTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  
  // 标记正在编辑的字段（避免服务端覆盖特定字段）
  const [editingFields, setEditingFields] = React.useState<Set<string>>(new Set());

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

  // 更新周期信息（仅用于进度条动画）
  React.useEffect(() => {
    if (operatorStatus.cycleInfo && radio.state.currentMode) {
      const { cycleProgress } = operatorStatus.cycleInfo;
      const cycleDurationMs = radio.state.currentMode.slotMs;
      
      // 根据当前进度反推周期开始时间（仅用于进度条动画）
      const now = Date.now();
      const cycleStartMs = now - (cycleProgress * cycleDurationMs);
      
      cycleInfoRef.current = {
        cycleStartMs,
        cycleDurationMs,
      };
    }
  }, [operatorStatus.cycleInfo, radio.state.currentMode]);

  // 使用requestAnimationFrame实现60fps平滑进度条动画
  React.useEffect(() => {
    if (!cycleInfoRef.current) return;

    let lastProgress = -1;

    const updateProgress = () => {
      if (!cycleInfoRef.current) return;
      
      const now = Date.now();
      const { cycleStartMs, cycleDurationMs } = cycleInfoRef.current;
      
      // 计算当前周期经过的时间
      const elapsedMs = now - cycleStartMs;
      let progress = (elapsedMs % cycleDurationMs) / cycleDurationMs;
      
      // 确保进度在0-1范围内
      if (progress < 0) progress = 0;
      if (progress > 1) progress = 1;
      
      const progressPercent = Math.round(progress * 1000) / 10; // 精确到0.1%
      
      // 只在值实际变化时才更新状态，避免不必要的重新渲染
      if (progressPercent !== lastProgress) {
        setRealtimeProgress(progressPercent);
        lastProgress = progressPercent;
      }
      
      // 继续下一帧动画
      animationFrameRef.current = requestAnimationFrame(updateProgress);
    };

    // 开始动画循环
    animationFrameRef.current = requestAnimationFrame(updateProgress);
    
    // 清理函数
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [operatorStatus.cycleInfo]); // 只依赖于cycleInfo的变化

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
  const sendUserCommand = (command: string, args: any) => {
    if (connection.state.radioService) {
      connection.state.radioService.sendUserCommand(operatorStatus.id, command, args);
    }
  };

  // 处理上下文更新
  const handleContextUpdate = (field: string, value: any) => {
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
  const getCurrentTransmitCycle = () => {
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
  const handleTransmitCycleChange = (keys: Selection) => {
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

  // 获取进度条背景样式 - 完全依赖服务端推送的状态
  const getProgressBackgroundStyle = () => {
    const progress = realtimeProgress / 100;
    
    if (!operatorStatus.cycleInfo || !radio.state.currentMode) {
      // 默认状态 - 使用CSS变量适配暗黑模式
      return {
        background: `linear-gradient(to right, var(--ft8-cycle-even-bg) 0%, var(--ft8-cycle-even-bg) ${progress * 100}%, hsl(var(--heroui-background)) ${progress * 100}%, hsl(var(--heroui-background)) 100%)`
      };
    }
    
    const { currentCycle, isTransmitCycle } = operatorStatus.cycleInfo;
    
    // 检查是否实际在发射：发射开关开启 && 服务端判断当前为发射周期
    const isActuallyTransmitting = operatorStatus.isTransmitting && isTransmitCycle;
    
    if (isActuallyTransmitting) {
      // 实际发射时为红色渐变 - 使用danger色彩适配暗黑模式
      return {
        background: `linear-gradient(to right, hsl(var(--heroui-danger) / 0.1) 0%, hsl(var(--heroui-danger) / 0.1) ${progress * 100}%, hsl(var(--heroui-background)) ${progress * 100}%, hsl(var(--heroui-background)) 100%)`
      };
    } else {
      // 其他情况：根据当前周期类型显示对应颜色
      // 使用统一的周期计算方法
      const isEvenCycle = CycleUtils.isEvenCycle(currentCycle);
      
      if (isEvenCycle) {
        // 偶数周期：使用CSS变量适配暗黑模式
        return {
          background: `linear-gradient(to right, var(--ft8-cycle-even-bg) 0%, var(--ft8-cycle-even-bg) ${progress * 100}%, hsl(var(--heroui-background)) ${progress * 100}%, hsl(var(--heroui-background)) 100%)`
        };
      } else {
        // 奇数周期：使用CSS变量适配暗黑模式
        return {
          background: `linear-gradient(to right, var(--ft8-cycle-odd-bg) 0%, var(--ft8-cycle-odd-bg) ${progress * 100}%, hsl(var(--heroui-background)) ${progress * 100}%, hsl(var(--heroui-background)) 100%)`
        };
      }
    }
  };

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
      <div 
        className="relative h-12 p-4 transition-all duration-75 ease-linear"
        style={getProgressBackgroundStyle()}
      >
        <div className="flex items-center justify-between h-full">
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
            <Switch 
              isSelected={operatorStatus.isTransmitting} 
              onValueChange={(isSelected) => {
                if (connection.state.radioService) {
                  if (isSelected) {
                    connection.state.radioService.startOperator(operatorStatus.id);
                  } else {
                    connection.state.radioService.stopOperator(operatorStatus.id);
                  }
                }
              }}
              size="sm"
              color="danger"
              isDisabled={!connection.state.isConnected}
              aria-label="切换发射状态"
            />
          </div>
        </div>
      </div>
      
      {/* 分割线 */}
      <div className="border-t border-divider"></div>
      
      {/* 下半部分 */}
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
