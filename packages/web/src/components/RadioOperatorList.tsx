import * as React from 'react';
import { useRadioState, useConnection } from '../store/radioStore';
import { RadioOperator } from './RadioOperator';

export const RadioOperatorList: React.FC = () => {
  const radio = useRadioState();
  const connection = useConnection();

  // 连接后请求操作员列表
  React.useEffect(() => {
    console.log('🔍 [RadioOperatorList] 连接状态检查:', {
      isConnected: connection.state.isConnected,
      hasRadioService: !!connection.state.radioService,
      operatorCount: radio.state.operators.length
    });
    
    if (connection.state.isConnected && connection.state.radioService) {
      console.log('🔗 [RadioOperatorList] 连接成功，延迟500ms后请求操作员列表');
      // 延迟一下确保WebSocket完全就绪
      const timer = setTimeout(() => {
        console.log('📤 [RadioOperatorList] 正在请求操作员列表...');
        connection.state.radioService?.getOperators();
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [connection.state.isConnected, connection.state.radioService]);

  // 监听操作员状态变化
  React.useEffect(() => {
    console.log('📻 [RadioOperatorList] 操作员状态更新:', {
      operatorCount: radio.state.operators.length,
      operators: radio.state.operators
    });
  }, [radio.state.operators]);

  if (radio.state.operators.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-center">
          <div className="text-default-500">
            {connection.state.isConnected ? '正在加载操作员...' : '请先连接到服务器'}
          </div>
          <div className="text-xs text-default-400 mt-2">
            连接: {connection.state.isConnected ? '已连接' : '未连接'} | 
            服务: {connection.state.radioService ? '已初始化' : '未初始化'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {radio.state.operators.map((operator) => (
        <RadioOperator
          key={operator.id}
          operatorStatus={operator}
        />
      ))}
    </div>
  );
}; 