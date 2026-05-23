import * as React from 'react';
import { Alert, Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { useOperators, useConnection } from '../../../store/radioStore';
import { useRadioModeState } from '../../../store/radio/hooks';
import { useAuth } from '../../../store/authStore';
import { RadioOperator } from './RadioOperator';
import { useTranslation } from 'react-i18next';
import {
  deriveSameCallsignStandardFrequencyWarning,
  formatSameCallsignWarningCallsigns,
} from '../../../utils/standardDigitalFrequencyWarning';
import { usePluginSnapshot } from '../../../hooks/usePluginSnapshot';

interface RadioOperatorListProps {
  onCreateOperator?: () => void; // 创建操作员的回调
}

export const RadioOperatorList: React.FC<RadioOperatorListProps> = ({ onCreateOperator }) => {
  const { t } = useTranslation('radio');
  const { operators } = useOperators();
  const connection = useConnection();
  const { currentMode, currentRadioFrequency } = useRadioModeState();
  const { state: authState } = useAuth();
  const pluginSnapshot = usePluginSnapshot();
  const standardFrequencyWarning = React.useMemo(
    () => deriveSameCallsignStandardFrequencyWarning(
      operators,
      currentMode?.name,
      currentRadioFrequency,
    ),
    [operators, currentMode?.name, currentRadioFrequency],
  );
  const standardFrequencyWarningCallsigns = standardFrequencyWarning
    ? formatSameCallsignWarningCallsigns(standardFrequencyWarning.groups)
    : '';

  // 连接后请求操作员列表
  React.useEffect(() => {
    /* console.log('🔍 [RadioOperatorList] 连接状态检查:', {
      isConnected: connection.state.isConnected,
      hasRadioService: !!connection.state.radioService,
      operatorCount: radio.state.operators.length
    }); */
    
    if (connection.state.isReady && connection.state.radioService) {
      // console.log('🔗 [RadioOperatorList] 连接成功，延迟500ms后请求操作员列表');
      // 延迟一下确保WebSocket完全就绪
      const timer = setTimeout(() => {
        // console.log('📤 [RadioOperatorList] 正在请求操作员列表...');
        connection.state.radioService?.getOperators();
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [connection.state.isReady, connection.state.radioService]);

  if (operators.length === 0) {
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
            ) : authState.role === 'admin' || authState.role === 'operator' ? (
              // 有操作权限，显示创建按钮
              <Button
                onPress={onCreateOperator}
                variant="bordered"
                size="md"
                className="w-full border-2 border-dashed border-default-300 hover:border-default-400 bg-transparent hover:bg-content1 text-default-500 py-3"
              >
                <FontAwesomeIcon icon={faPlus} className="mr-2" />
                {t('operator.createFirst')}
              </Button>
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
      {standardFrequencyWarning && (
        <Alert
          color="warning"
          variant="flat"
          title={t('operator.standardFrequencyMultiTxTitle')}
          className="text-xs"
        >
          {t('operator.standardFrequencyMultiTxDesc', {
            callsigns: standardFrequencyWarningCallsigns,
          })}
        </Alert>
      )}
      {operators.map((operator) => (
        <RadioOperator
          key={operator.id}
          operatorStatus={operator}
          pluginStatuses={pluginSnapshot.plugins}
        />
      ))}
    </div>
  );
}; 
