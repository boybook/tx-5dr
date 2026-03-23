import * as React from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faEyeSlash } from '@fortawesome/free-solid-svg-icons';
import { useRadioState, useConnection } from '../store/radioStore';
import { useAuth } from '../store/authStore';
import { RadioOperator } from './RadioOperator';
import { hasHiddenOperators } from '../utils/operatorPreferences';
import { useTranslation } from 'react-i18next';

interface RadioOperatorListProps {
  onCreateOperator?: () => void; // 创建操作员的回调
}

export const RadioOperatorList: React.FC<RadioOperatorListProps> = ({ onCreateOperator }) => {
  const { t } = useTranslation('radio');
  const radio = useRadioState();
  const connection = useConnection();
  const { state: authState } = useAuth();

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

  if (radio.state.operators.length === 0) {
    return (
      <div className="flex items-center justify-center">
        <div className="text-center w-full">
          {connection.state.isConnected ? (
            // 优先判断角色权限，再判断客户端偏好设置
            authState.role === 'viewer' || authState.isPublicViewer ? (
              // 仅查看权限
              <div className="cursor-default select-none">
                <div className="text-xs text-default-400">{t('operator.viewOnly')}</div>
              </div>
            ) : authState.operatorIds.length === 0 && (authState.role === 'admin' || authState.role === 'operator') ? (
              // 有操作权限但无操作员，显示创建按钮
              <Button
                onPress={onCreateOperator}
                variant="bordered"
                size="md"
                className="w-full border-2 border-dashed border-default-300 hover:border-default-400 bg-transparent hover:bg-content1 text-default-500 py-3"
              >
                <FontAwesomeIcon icon={faPlus} className="mr-2" />
                {t('operator.createFirst')}
              </Button>
            ) : hasHiddenOperators() ? (
              // 有操作权限的用户，客户端偏好设置隐藏了所有操作员
              <div className="cursor-default select-none space-y-3">
                <div className="text-xs text-default-400">
                  <FontAwesomeIcon icon={faEyeSlash} className="mr-2" />
                  <span>{t('operator.allHidden')}</span>
                </div>
              </div>
            ) : (
              // 其他情况（不应发生）
              <div className="cursor-default select-none">
                <div className="text-xs text-default-400">{t('operator.none')}</div>
              </div>
            )
          ) : (
            // 未连接时的提示
            <div className="cursor-default select-none">
              <div className="text-default-500">{t('operator.connectFirst')}</div>
              <div className="text-xs text-default-400 mt-2">
                {t('operator.connectStatus', { connected: connection.state.isConnected ? t('connection.connected') : t('connection.disconnected'), service: connection.state.radioService ? t('operator.initialized') : t('operator.notInitialized') })}
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