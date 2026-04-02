import React, { useState, useCallback } from 'react';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@heroui/react';
import { useOperators } from '../store/radioStore';
import { useAuth } from '../store/authStore';
import { AuthLoginForm } from '../components/AuthLoginForm';
import { RadioControl } from '../components/RadioControl';
import { RadioOperatorList } from '../components/RadioOperatorList';
import { MyRelatedFramesTable } from '../components/MyRelatedFramesTable';
import { ThemeToggle } from '../components/ThemeToggle';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faCog, faKey, faLock, faRightFromBracket, faUser } from '@fortawesome/free-solid-svg-icons';
import { AutomationSettingsPanel } from '../components/AutomationSettingsPanel';
import { ServerHealthButton } from '../components/ServerHealthButton';
import { useTranslation } from 'react-i18next';
import { OPEN_ACCOUNT_SECURITY_MODAL_EVENT } from '../components/GlobalModalHost';

export const RightLayout: React.FC = () => {
  const { t } = useTranslation('common');
  const ROLE_LABELS: Record<string, string> = {
    viewer: t('common:role.viewer'),
    operator: t('common:role.operator'),
    admin: t('common:role.admin'),
  };
  const { operators } = useOperators();
  const { state: authState, logout } = useAuth();
  const [selectedMode, setSelectedMode] = useState<string>('auto5');
  const [loginPopoverOpen, setLoginPopoverOpen] = useState(false);
  const showAuthenticatedIdentity = Boolean(authState.role) && (Boolean(authState.jwt) || !authState.authEnabled);
  const showLoginEntry = authState.authEnabled && !authState.jwt && authState.isPublicViewer;

  // 判断是否为自动模式
  const isAutoMode = selectedMode.startsWith('auto');

  // 处理模式选择变化
  const _handleModeChange = (keys: Set<string> | 'all') => {
    if (keys === 'all') return;
    const selectedKey = Array.from(keys)[0] as string;
    setSelectedMode(selectedKey);
  };

  // 打开设置弹窗
  const handleOpenSettings = () => {
    window.dispatchEvent(new CustomEvent('openSettingsModal', { detail: { tab: 'radio' } }));
  };

  // 处理创建操作员
  const handleCreateOperator = () => {
    window.dispatchEvent(new CustomEvent('openSettingsModal', { detail: { tab: 'operator' } }));
  };

  // 处理打开电台设置（Profile Modal）
  const handleOpenRadioSettings = () => {
    window.dispatchEvent(new Event('openProfileModal'));
  };

  const handleOpenAccountSecurity = useCallback(() => {
    window.dispatchEvent(new Event(OPEN_ACCOUNT_SECURITY_MODAL_EVENT));
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div
        className="flex-shrink-0 flex justify-between items-center p-1 px-2 md:p-2 md:px-3"
        style={{
          WebkitAppRegion: 'drag',
        } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        <div></div>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          <div className="flex items-center gap-1">
            {/* 自动化程序（有操作员时才显示） */}
            {operators.length > 0 && (
              <Popover placement="bottom-start">
                <PopoverTrigger>
                  <Button
                    variant="light"
                    size="sm"
                    title={t('automation.title')}
                    className={`${isAutoMode ? 'bg-success-50 select-auto-mode' : 'bg-content2 select-manual-mode'} rounded-md px-3 h-6 text-xs font-mono text-default-600 leading-none`}
                  >
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 bg-success-500 rounded-full flex-shrink-0"></div>
                      <span className="truncate">{t('automation.title')}</span>
                      <FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs -mr-1" />
                    </div>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="px-1">
                  <div>
                    <AutomationSettingsPanel isOpen={true} onClose={() => {}} />
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {/* 认证状态 UI */}
            {showAuthenticatedIdentity ? (
                // 已认证：显示用户信息 + 登出
                <Popover placement="bottom-end">
                  <PopoverTrigger>
                    <Button
                      variant="light"
                      size="sm"
                      className="bg-content2 rounded-md px-3 h-6 text-xs text-default-500 leading-none"
                    >
                      <FontAwesomeIcon icon={faUser} className="text-default-400 text-xs" />
                      {authState.role === 'admin' ? t('role.admin') : (authState.label || ROLE_LABELS[authState.role || ''] || t('auth.user'))}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-3 gap-2">
                    <div className="text-sm font-medium">
                      {authState.label || ROLE_LABELS[authState.role || ''] || t('auth.user')}
                    </div>
                    <div className="text-xs text-default-500">{t('auth.role')}: {ROLE_LABELS[authState.role || ''] || authState.role}</div>
                    {authState.authEnabled && authState.jwt && (
                      <>
                        <Button
                          size="sm"
                          variant="flat"
                          startContent={<FontAwesomeIcon icon={faLock} />}
                          onPress={handleOpenAccountSecurity}
                        >
                          {t('auth:accountSecurity.trigger')}
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          color="danger"
                          startContent={<FontAwesomeIcon icon={faRightFromBracket} />}
                          onPress={logout}
                          className="mt-1"
                        >
                          {t('auth.logout')}
                        </Button>
                      </>
                    )}
                  </PopoverContent>
                </Popover>
              ) : showLoginEntry ? (
                // 公开观察者：显示登录入口
                <Popover
                  placement="bottom-end"
                  isOpen={loginPopoverOpen}
                  onOpenChange={setLoginPopoverOpen}
                  >
                    <PopoverTrigger>
                      <Button variant="light" size="sm" className="bg-content2 rounded-md px-3 h-6 text-xs text-default-500 leading-none">
                      <FontAwesomeIcon icon={faKey} className="text-default-400 text-xs" />
                      {t('auth.login')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-3 w-80">
                    <AuthLoginForm
                      compact
                      autoFocus
                      onSuccess={() => setLoginPopoverOpen(false)}
                    />
                  </PopoverContent>
                </Popover>
              ) : null}
          </div>
          <div className="flex items-center gap-0">
            <ServerHealthButton />
            <ThemeToggle variant="dropdown" size="sm" />
            <Button
              onPress={handleOpenSettings}
              isIconOnly
              variant="light"
              size="sm"
              title={t('action.openSettings')}
              aria-label={t('action.openSettings')}
            >
              <FontAwesomeIcon icon={faCog} className="text-default-400 text-sm" />
            </Button>
          </div>
        </div>
      </div>
      
      {/* 主内容区域 */}
      <div className="flex-1 p-2 pt-0 md:p-5 md:pt-0 flex flex-col gap-2 md:gap-4 min-h-0">
        {/* 和我有关的通联信息 - 占据剩余空间 */}
        <div className="flex-1 min-h-0">
          <MyRelatedFramesTable className="h-full" />
        </div>
        
        {/* 操作员列表 - 固定高度 */}
        <div className="flex-shrink-0">
          <RadioOperatorList onCreateOperator={handleCreateOperator} />
        </div>
        
        {/* 电台控制 - 固定高度 */}
        <div className="flex-shrink-0">
          <RadioControl onOpenRadioSettings={handleOpenRadioSettings} />
        </div>
      </div>
    </div>
  );
};
