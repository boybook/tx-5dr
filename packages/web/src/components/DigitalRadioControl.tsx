import React, { useState, useEffect, useCallback } from 'react';
import { DigitalRadioWebSocketClient } from '../sdk/websocket-client';
import { DecodeDisplay } from './DecodeDisplay';
import type { SlotPack, ModeDescriptor } from '@tx5dr/contracts';
import './DigitalRadioControl.css';

interface SystemStatus {
  isRunning: boolean;
  currentMode: ModeDescriptor;
  currentTime: number;
  nextSlotIn: number;
}

export const DigitalRadioControl: React.FC = () => {
  const [wsClient] = useState(() => new DigitalRadioWebSocketClient('ws://localhost:4000/api/ws'));
  const [isConnected, setIsConnected] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [slotPacks, setSlotPacks] = useState<SlotPack[]>([]);
  const [eventLogs, setEventLogs] = useState<string[]>([]);
  const [maxLogs] = useState(50);

  // 添加事件日志
  const addEventLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setEventLogs(prev => [`[${timestamp}] ${message}`, ...prev.slice(0, maxLogs - 1)]);
  }, [maxLogs]);

  // 设置WebSocket事件监听器
  useEffect(() => {
    wsClient.on('connected', () => {
      setIsConnected(true);
      addEventLog('🔗 WebSocket连接已建立');
    });

    wsClient.on('disconnected', () => {
      setIsConnected(false);
      addEventLog('🔌 WebSocket连接已断开');
    });

    wsClient.on('error', (error) => {
      addEventLog(`❌ WebSocket错误: ${error.message}`);
    });

    wsClient.on('systemStatus', (status) => {
      setSystemStatus(status);
      addEventLog(`📊 系统状态更新: ${status.isRunning ? '运行中' : '已停止'} - ${status.currentMode.name}`);
    });

    wsClient.on('modeChanged', (mode) => {
      addEventLog(`🔄 模式切换: ${mode.name}`);
    });

    wsClient.on('clockStarted', () => {
      addEventLog('🚀 数字无线电引擎已启动');
    });

    wsClient.on('clockStopped', () => {
      addEventLog('🛑 数字无线电引擎已停止');
    });

    wsClient.on('slotStart', (slotInfo) => {
      addEventLog(`🎯 时隙开始: ${slotInfo.id}`);
    });

    wsClient.on('subWindow', (windowInfo) => {
      addEventLog(`🔍 子窗口: 时隙${windowInfo.slotInfo.id} 窗口${windowInfo.windowIdx}`);
    });

    wsClient.on('slotPackUpdated', (slotPack) => {
      // 更新slotPacks状态
      setSlotPacks(prev => {
        const existing = prev.find(sp => sp.slotId === slotPack.slotId);
        if (existing) {
          return prev.map(sp => sp.slotId === slotPack.slotId ? slotPack : sp);
        } else {
          return [slotPack, ...prev.slice(0, 19)]; // 保持最多20个时隙包
        }
      });
      
      if (slotPack.frames.length > 0) {
        addEventLog(`📦 解码成功: 时隙${slotPack.slotId} - ${slotPack.frames.length}个信号`);
      }
    });

    wsClient.on('decodeError', (errorInfo) => {
      addEventLog(`💥 解码错误: ${errorInfo.error.message}`);
    });

    wsClient.on('commandResult', (result) => {
      if (result.success) {
        addEventLog(`✅ 命令执行成功: ${result.command}`);
      } else {
        addEventLog(`❌ 命令执行失败: ${result.command} - ${result.error}`);
      }
    });

    // 连接到WebSocket
    wsClient.connect().catch((error) => {
      addEventLog(`❌ 连接失败: ${error.message}`);
    });

    // 清理函数
    return () => {
      wsClient.disconnect();
    };
  }, [wsClient, addEventLog]);

  const handleStartEngine = () => {
    wsClient.startEngine();
  };

  const handleStopEngine = () => {
    wsClient.stopEngine();
  };

  const handleRefreshStatus = () => {
    wsClient.getStatus();
  };

  const handlePing = () => {
    wsClient.ping();
  };

  const clearLogs = () => {
    setEventLogs([]);
  };

  return (
    <div className="digital-radio-control">
      <div className="control-header">
        <h2>🚀 TX-5DR 数字无线电控制台</h2>
        <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? '🟢 已连接' : '🔴 未连接'}
        </div>
      </div>

      <div className="control-panel">
        <div className="system-info">
          <h3>系统状态</h3>
          {systemStatus ? (
            <div className="status-grid">
              <div className="status-item">
                <label>运行状态:</label>
                <span className={systemStatus.isRunning ? 'status-running' : 'status-stopped'}>
                  {systemStatus.isRunning ? '🟢 运行中' : '🔴 已停止'}
                </span>
              </div>
              <div className="status-item">
                <label>当前模式:</label>
                <span>{systemStatus.currentMode.name}</span>
              </div>
              <div className="status-item">
                <label>时隙长度:</label>
                <span>{systemStatus.currentMode.slotMs}ms</span>
              </div>
            </div>
          ) : (
            <p className="loading">正在获取系统状态...</p>
          )}
        </div>

        <div className="control-buttons">
          <button 
            onClick={handleStartEngine}
            disabled={!isConnected || systemStatus?.isRunning}
            className="btn btn-start"
          >
            🚀 启动引擎
          </button>
          <button 
            onClick={handleStopEngine}
            disabled={!isConnected || !systemStatus?.isRunning}
            className="btn btn-stop"
          >
            🛑 停止引擎
          </button>
          <button 
            onClick={handleRefreshStatus}
            disabled={!isConnected}
            className="btn btn-refresh"
          >
            🔄 刷新状态
          </button>
          <button 
            onClick={handlePing}
            disabled={!isConnected}
            className="btn btn-ping"
          >
            🏓 Ping
          </button>
        </div>
      </div>

      <DecodeDisplay slotPacks={slotPacks} />

      <div className="event-logs">
        <div className="logs-header">
          <h3>事件日志 ({eventLogs.length})</h3>
          <button onClick={clearLogs} className="btn btn-clear">
            🗑️ 清空日志
          </button>
        </div>
        <div className="logs-container">
          {eventLogs.length === 0 ? (
            <p className="no-logs">暂无事件日志</p>
          ) : (
            eventLogs.map((log, index) => (
              <div key={index} className="log-entry">
                {log}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}; 