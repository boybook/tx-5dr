import * as React from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faEyeSlash } from '@fortawesome/free-solid-svg-icons';
import { useRadioState, useConnection, useOperators, useCurrentOperatorId } from '../store/radioStore';
import { RadioOperator } from './RadioOperator';
import { hasOperatorPreferences } from '../utils/operatorPreferences';

interface RadioOperatorListProps {
  onCreateOperator?: () => void; // 创建操作员的回调
}

export const RadioOperatorList: React.FC<RadioOperatorListProps> = ({ onCreateOperator }) => {
  const radio = useRadioState();
  const connection = useConnection();

  // 连接后请求操作员列表
  React.useEffect(() => {
    /* console.log('🔍 [RadioOperatorList] 连接状态检查:', {
      isConnected: connection.state.isConnected,
      hasRadioService: !!connection.state.radioService,
      operatorCount: radio.state.operators.length
    }); */
    
    if (connection.state.isConnected && connection.state.radioService) {
      // console.log('🔗 [RadioOperatorList] 连接成功，延迟500ms后请求操作员列表');
      // 延迟一下确保WebSocket完全就绪
      const timer = setTimeout(() => {
        // console.log('📤 [RadioOperatorList] 正在请求操作员列表...');
        connection.state.radioService?.getOperators();
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [connection.state.isConnected, connection.state.radioService]);

  // 监听操作员状态变化
  /* React.useEffect(() => {
    console.log('📻 [RadioOperatorList] 操作员状态更新:', {
      operatorCount: radio.state.operators.length,
      operators: radio.state.operators
    });
  }, [radio.state.operators]); */

  if (radio.state.operators.length === 0) {
    return (
      <div className="flex items-center justify-center">
        <div className="text-center w-full">
          {connection.state.isConnected ? (
            // 区分"服务端没有操作员"和"客户端禁用了所有操作员"
            hasOperatorPreferences() ? (
              // 用户有偏好设置但所有操作员都被禁用了
              <div className="cursor-default select-none space-y-3">
                <div className="text-xs text-default-400">
                  <FontAwesomeIcon icon={faEyeSlash} className="mr-2" />
                  <span>所有操作员均已隐藏</span>
                </div>
              </div>
            ) : (
              // 服务端真的没有操作员，显示创建按钮
              <Button
                onPress={onCreateOperator}
                variant="bordered"
                size="md"
                className="w-full border-2 border-dashed border-default-300 hover:border-default-400 bg-transparent hover:bg-default-50 text-default-500 py-3"
              >
                <FontAwesomeIcon icon={faPlus} className="mr-2" />
                创建第一个操作员
              </Button>
            )
          ) : (
            // 未连接时的提示
            <div className="cursor-default select-none">
              <div className="text-default-500">请先连接到服务器</div>
              <div className="text-xs text-default-400 mt-2">
                连接: {connection.state.isConnected ? '已连接' : '未连接'} | 
                服务: {connection.state.radioService ? '已初始化' : '未初始化'}
              </div>
            </div>
          )}
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