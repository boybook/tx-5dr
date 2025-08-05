import React, { useEffect, useState } from 'react';
import { HeroUIProvider } from '@heroui/react';
import { configureApi } from '@tx5dr/core';
import { getApiBaseUrl } from '../utils/config';
import { RadioProvider, useOperators } from '../store/radioStore';
import { useTheme } from '../hooks/useTheme';
import { ThemeToggle } from '../components/ThemeToggle';
import LogbookViewer from '../components/LogbookViewer';
import '../index.css';

/**
 * 页面内容组件 - 需要RadioProvider包装
 */
const LogbookContent: React.FC = () => {
  const [operatorId, setOperatorId] = useState<string>('');
  const [logBookId, setLogBookId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  
  // 获取操作员信息以显示呼号
  const { operators } = useOperators();
  const currentOperator = operators.find(op => op.id === operatorId);
  const operatorCallsign = currentOperator?.context?.myCall || operatorId;

  useEffect(() => {
    // 配置API
    configureApi(getApiBaseUrl());

    // 从URL参数获取操作员ID和日志本ID
    const urlParams = new URLSearchParams(window.location.search);
    const opId = urlParams.get('operatorId');
    const logId = urlParams.get('logBookId');
    
    if (!opId) {
      console.error('缺少操作员ID参数');
      setLoading(false);
      return;
    }

    setOperatorId(opId);
    setLogBookId(logId || '');
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
          <p className="mt-4 text-foreground">加载通联日志中...</p>
        </div>
      </div>
    );
  }

  if (!operatorId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center text-danger">
          <h1 className="text-2xl font-bold mb-4">错误</h1>
          <p>缺少必要的操作员ID参数</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* 顶部拖拽条 - 很矮，避免与macOS交通灯冲突 */}
      <div
        className="flex-shrink-0 h-8 flex justify-end items-center px-4"
        style={{ 
          WebkitAppRegion: 'drag',
        } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        {/* 只放主题切换按钮 */}
        <div 
          className="flex items-center" 
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
        >
          <ThemeToggle variant="button" size="sm" />
        </div>
      </div>
      
      {/* 内容区域 */}
      <div className="flex-1 overflow-auto">
        <LogbookViewer 
          operatorId={operatorId} 
          logBookId={logBookId}
          operatorCallsign={operatorCallsign}
        />
      </div>
    </div>
  );
};

/**
 * 主题感知包装器
 */
const ThemedLogbookWrapper: React.FC = () => {
  // 使用主题钩子来确保主题正确应用
  useTheme();
  
  return (
    <RadioProvider>
      <LogbookContent />
    </RadioProvider>
  );
};

/**
 * 通联日志独立页面
 * 用于在新窗口或新标签页中显示通联日志
 */
const LogbookPage: React.FC = () => {
  return (
    <HeroUIProvider>
      <ThemedLogbookWrapper />
    </HeroUIProvider>
  );
};

export default LogbookPage;