import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@heroui/react';
import { useRadioState, useOperators } from '../store/radioStore';
import { useAuth, useHasMinRole } from '../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { RadioControl } from '../components/RadioControl';
import { RadioOperatorList } from '../components/RadioOperatorList';
import { SettingsModal } from '../components/SettingsModal';
import { ProfileModal } from '../components/ProfileModal';
import { MyRelatedFramesTable } from '../components/MyRelatedFramesTable';
import { ThemeToggle } from '../components/ThemeToggle';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faCog, faKey, faRightFromBracket, faUser } from '@fortawesome/free-solid-svg-icons';
import { AutomationSettingsPanel } from '../components/AutomationSettingsPanel';

// 角色中文标签
const ROLE_LABELS: Record<string, string> = {
  viewer: '观察者',
  operator: '操作员',
  admin: '管理员',
};

export const RightLayout: React.FC = () => {
  const _radio = useRadioState();
  const { operators } = useOperators();
  const { state: authState, login, logout } = useAuth();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [selectedMode, setSelectedMode] = useState<string>('auto5');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'audio' | 'radio' | 'operator' | 'display' | 'logbook_sync' | 'system'>('radio');
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginPopoverOpen, setLoginPopoverOpen] = useState(false);

  // 处理 Popover 内的登录
  const handlePopoverLogin = useCallback(async () => {
    if (!loginToken.trim()) return;
    const ok = await login(loginToken.trim());
    if (ok) {
      setLoginToken('');
      setLoginPopoverOpen(false);
    }
  }, [loginToken, login]);

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
    setSettingsInitialTab('radio');
    setIsSettingsOpen(true);
  };

  // 关闭设置弹窗
  const handleCloseSettings = () => {
    setIsSettingsOpen(false);
  };

  // 处理创建操作员
  const handleCreateOperator = () => {
    setSettingsInitialTab('operator');
    setIsSettingsOpen(true);
  };

  // 处理打开电台设置（Profile Modal）
  const handleOpenRadioSettings = () => {
    setIsProfileModalOpen(true);
  };

  // 监听全局 openProfileModal 事件（来自错误 toast 的"打开设置"按钮）
  useEffect(() => {
    const handler = () => setIsProfileModalOpen(true);
    window.addEventListener('openProfileModal', handler);
    return () => window.removeEventListener('openProfileModal', handler);
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
        <div></div> {/* 左侧空白 */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          <div className="flex items-center gap-1">
            {/* 自动化程序（有操作员时才显示） */}
            {operators.length > 0 && (
              <Popover placement="bottom-start">
                <PopoverTrigger>
                  <Button
                    variant="light"
                    size="sm"
                    title="自动化程序"
                    className={`${isAutoMode ? 'bg-success-50 select-auto-mode' : 'bg-content2 select-manual-mode'} rounded-md px-3 h-6 text-xs font-mono text-default-600 leading-none`}
                  >
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 bg-success-500 rounded-full flex-shrink-0"></div>
                      <span className="truncate">自动化程序</span>
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
            {authState.authEnabled && (
              authState.jwt ? (
                // 已认证：显示用户信息 + 登出
                <Popover placement="bottom-end">
                  <PopoverTrigger>
                    <Button
                      variant="light"
                      size="sm"
                      className="bg-content2 rounded-md px-3 h-6 text-xs text-default-500 leading-none"
                    >
                      <FontAwesomeIcon icon={faUser} className="text-default-400 text-xs" />
                      {authState.role === 'admin' ? '管理员' : (authState.label || ROLE_LABELS[authState.role || ''] || '用户')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-3 gap-2">
                    <div className="text-sm font-medium">{authState.label}</div>
                    <div className="text-xs text-default-500">角色: {ROLE_LABELS[authState.role || ''] || authState.role}</div>
                    <Button
                      size="sm"
                      variant="flat"
                      color="danger"
                      startContent={<FontAwesomeIcon icon={faRightFromBracket} />}
                      onPress={logout}
                      className="mt-1"
                    >
                      登出
                    </Button>
                  </PopoverContent>
                </Popover>
              ) : authState.isPublicViewer ? (
                // 公开观察者：显示登录入口
                <Popover
                  placement="bottom-end"
                  isOpen={loginPopoverOpen}
                  onOpenChange={setLoginPopoverOpen}
                >
                  <PopoverTrigger>
                    <Button variant="light" size="sm" className="bg-content2 rounded-md px-3 h-6 text-xs text-default-500 leading-none">
                      <FontAwesomeIcon icon={faKey} className="text-default-400 text-xs" />
                      登录
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-3 gap-2 w-64">
                    <div className="text-sm font-medium">输入访问令牌</div>
                    <Input
                      size="sm"
                      type="password"
                      placeholder="粘贴令牌..."
                      value={loginToken}
                      onValueChange={setLoginToken}
                      onKeyDown={(e) => e.key === 'Enter' && handlePopoverLogin()}
                      autoFocus
                    />
                    {authState.loginError && (
                      <p className="text-danger text-xs">{authState.loginError}</p>
                    )}
                    <Button
                      size="sm"
                      color="primary"
                      isLoading={authState.loginLoading}
                      onPress={handlePopoverLogin}
                      isDisabled={!loginToken.trim()}
                      fullWidth
                    >
                      登录
                    </Button>
                  </PopoverContent>
                </Popover>
              ) : null
            )}
          </div>
          <div className="flex items-center gap-0">
            <ThemeToggle variant="dropdown" size="sm" />
            <Button
              onPress={handleOpenSettings}
              isIconOnly
              variant="light"
              size="sm"
              title="设置"
              aria-label="打开设置"
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

      {/* 设置弹窗 */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={handleCloseSettings}
        initialTab={settingsInitialTab}
      />

      {/* Profile 管理弹窗（仅 Admin） */}
      {isAdmin && (
        <ProfileModal
          isOpen={isProfileModalOpen}
          onClose={() => setIsProfileModalOpen(false)}
        />
      )}
    </div>
  );
};