import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@heroui/react';
import { useCurrentOperatorId, useOperators } from '../store/radioStore';
import { useAuth } from '../store/authStore';
import { AuthLoginForm } from '../components/auth/AuthLoginForm';
import { RadioControl } from '../components/radio/control/RadioControl';
import { RadioOperatorList } from '../components/radio/operators/RadioOperatorList';
import { MyRelatedFramesTable } from '../components/radio/digital/MyRelatedFramesTable';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { QSONotificationToggleButton } from '../components/common/QSONotificationToggleButton';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faKey, faLock, faRightFromBracket, faUser } from '@fortawesome/free-solid-svg-icons';
import { AutomationSettingsPanel } from '../components/radio/automation/AutomationSettingsPanel';
import { ServerHealthButton } from '../components/system/ServerHealthButton';
import { SettingsButton } from '../components/common/SettingsButton';
import { useTranslation } from 'react-i18next';
import { OPEN_ACCOUNT_SECURITY_MODAL_EVENT } from '../components/app/GlobalModalHost';
import {
  clampRightLayoutSplitPercent,
  clearRightLayoutSplitPercent,
  DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT,
  getStoredRightLayoutSplitPercent,
  hasStoredRightLayoutSplit,
  isActiveRightLayoutSplitPointer,
  getRightLayoutPaneHeights,
  RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX,
  saveRightLayoutSplitPercent,
  shouldPersistRightLayoutSplit,
  shouldStartRightLayoutSplitPointerDrag,
} from './rightLayoutSplitPreferences';

function RightLayoutPaneDivider({
  isDragging,
  onPointerDown,
  onDoubleClick,
  resetHint,
}: {
  isDragging: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  resetHint: string;
}) {
  return (
    <div
      className={[
        'group touch-none flex-shrink-0 cursor-row-resize transition-all duration-200',
        isDragging ? 'bg-primary-400' : 'bg-transparent hover:bg-primary-200',
      ].join(' ')}
      style={{ height: `${RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX}px` }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title={resetHint}
    >
      <div className="relative h-full w-full">
        <div
          className={[
            'absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 transform gap-1 transition-opacity duration-200',
            isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          ].join(' ')}
        >
          <div className="h-0.5 w-6 rounded-full bg-default-600"></div>
          <div className="h-0.5 w-6 rounded-full bg-default-600"></div>
          <div className="h-0.5 w-6 rounded-full bg-default-600"></div>
        </div>
      </div>
    </div>
  );
}

export const RightLayout: React.FC = () => {
  const { t } = useTranslation('common');
  const ROLE_LABELS: Record<string, string> = {
    viewer: t('common:role.viewer'),
    operator: t('common:role.operator'),
    admin: t('common:role.admin'),
  };
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const { state: authState, logout } = useAuth();
  const [selectedMode, setSelectedMode] = useState<string>('auto5');
  const [loginPopoverOpen, setLoginPopoverOpen] = useState(false);
  const [splitPercent, setSplitPercent] = useState(() => getStoredRightLayoutSplitPercent());
  // 用户未拖拽过分割条时保持 main 的经典布局（表格占据剩余空间、操作员区内容自然高度），
  // 仅在用户手动拖拽后切换到固定比例分割模式。
  const [hasCustomSplit, setHasCustomSplit] = useState(() => hasStoredRightLayoutSplit());
  const [workspaceHeight, setWorkspaceHeight] = useState(0);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const splitWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const topPaneRef = useRef<HTMLDivElement | null>(null);
  const pendingAutoConvertRef = useRef<number | null>(null);
  const activeSplitPointerIdRef = useRef<number | null>(null);
  const dragStartYRef = useRef(0);
  const dragStartSplitPercentRef = useRef(DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT);
  const wasDraggingSplitRef = useRef(false);
  const showAuthenticatedIdentity = Boolean(authState.role) && (Boolean(authState.jwt) || !authState.authEnabled);
  const showLoginEntry = authState.authEnabled && !authState.jwt && authState.isPublicViewer;
  const automationOperatorId = currentOperatorId || operators[0]?.id;

  // 判断是否为自动模式
  const isAutoMode = selectedMode.startsWith('auto');

  // 处理模式选择变化
  const _handleModeChange = (keys: Set<string> | 'all') => {
    if (keys === 'all') return;
    const selectedKey = Array.from(keys)[0] as string;
    setSelectedMode(selectedKey);
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

  useEffect(() => {
    const measureWorkspace = () => {
      const nextHeight = splitWorkspaceRef.current?.clientHeight ?? 0;
      setWorkspaceHeight((currentHeight) => currentHeight === nextHeight ? currentHeight : nextHeight);
    };

    measureWorkspace();

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        measureWorkspace();
      });

    if (resizeObserver && splitWorkspaceRef.current) {
      resizeObserver.observe(splitWorkspaceRef.current);
    }

    window.addEventListener('resize', measureWorkspace);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measureWorkspace);
    };
  }, []);

  useEffect(() => {
    if (!hasCustomSplit) {
      return;
    }

    setSplitPercent((currentSplitPercent) => {
      if (workspaceHeight <= 0) {
        return currentSplitPercent;
      }

      return clampRightLayoutSplitPercent({
        splitPercent: currentSplitPercent,
        containerHeight: workspaceHeight,
      });
    });
  }, [hasCustomSplit, workspaceHeight]);

  const handleSplitPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!shouldStartRightLayoutSplitPointerDrag({
      hasActivePointer: activeSplitPointerIdRef.current !== null,
      isPrimary: event.isPrimary,
      pointerType: event.pointerType,
      button: event.button,
    })) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    activeSplitPointerIdRef.current = event.pointerId;
    dragStartYRef.current = event.clientY;

    // 首次从自适应布局开始拖拽时，按当前实际像素高度换算起始比例；
    // 仅当指针真正移动后才切换为手动模式（pendingAutoConvertRef 在 move 中消费），
    // 避免单击分割条（零位移）就退出自适应并写入 localStorage
    let startSplitPercent = splitPercent;
    if (!hasCustomSplit) {
      const containerHeight = splitWorkspaceRef.current?.clientHeight ?? 0;
      const topPaneHeight = topPaneRef.current?.clientHeight ?? 0;
      // 与 getRightLayoutPaneHeights 保持一致：以扣除分割条后的可用高度为基准换算
      const usableHeight = containerHeight - RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX;
      if (usableHeight > 0 && topPaneHeight > 0) {
        startSplitPercent = clampRightLayoutSplitPercent({
          splitPercent: (topPaneHeight / usableHeight) * 100,
          containerHeight,
        });
      }
      pendingAutoConvertRef.current = startSplitPercent;
    }

    dragStartSplitPercentRef.current = startSplitPercent;
    setIsDraggingSplit(true);
  }, [hasCustomSplit, splitPercent]);

  const handleSplitPointerEnd = useCallback((event: PointerEvent) => {
    if (!isActiveRightLayoutSplitPointer(activeSplitPointerIdRef.current, event.pointerId)) {
      return;
    }
    activeSplitPointerIdRef.current = null;
    pendingAutoConvertRef.current = null;
    setIsDraggingSplit(false);
  }, []);

  // 双击分割条：清除持久化的分割比例，恢复自适应（经典）布局
  const handleSplitDividerDoubleClick = useCallback(() => {
    clearRightLayoutSplitPercent();
    setSplitPercent(DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT);
    setHasCustomSplit(false);
  }, []);

  const handleSplitPointerMove = useCallback((event: PointerEvent) => {
    if (!isActiveRightLayoutSplitPointer(activeSplitPointerIdRef.current, event.pointerId)) {
      return;
    }
    if (event.buttons === 0) {
      handleSplitPointerEnd(event);
      return;
    }
    if (!splitWorkspaceRef.current) {
      return;
    }

    const containerHeight = splitWorkspaceRef.current.clientHeight;
    if (containerHeight <= 0) {
      return;
    }

    // 指针真正移动时才从自适应切换为手动模式（单击不切换）
    if (pendingAutoConvertRef.current !== null) {
      setSplitPercent(pendingAutoConvertRef.current);
      setHasCustomSplit(true);
      pendingAutoConvertRef.current = null;
    }

    const deltaPercent = ((event.clientY - dragStartYRef.current) / containerHeight) * 100;
    setSplitPercent(clampRightLayoutSplitPercent({
      splitPercent: dragStartSplitPercentRef.current + deltaPercent,
      containerHeight,
    }));
  }, [handleSplitPointerEnd]);

  useEffect(() => {
    if (!isDraggingSplit) {
      return;
    }

    document.addEventListener('pointermove', handleSplitPointerMove);
    document.addEventListener('pointerup', handleSplitPointerEnd);
    document.addEventListener('pointercancel', handleSplitPointerEnd);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('pointermove', handleSplitPointerMove);
      document.removeEventListener('pointerup', handleSplitPointerEnd);
      document.removeEventListener('pointercancel', handleSplitPointerEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [handleSplitPointerEnd, handleSplitPointerMove, isDraggingSplit]);

  useEffect(() => {
    const wasDraggingSplit = wasDraggingSplitRef.current;
    wasDraggingSplitRef.current = isDraggingSplit;

    if (!shouldPersistRightLayoutSplit({
      wasDraggingSplit,
      isDraggingSplit,
    })) {
      return;
    }

    // 单击未拖动（未切换手动模式）时不落盘
    if (!hasCustomSplit) {
      return;
    }

    saveRightLayoutSplitPercent(splitPercent);
  }, [isDraggingSplit, hasCustomSplit, splitPercent]);

  const desktopPaneHeights = getRightLayoutPaneHeights({
    splitPercent,
    containerHeight: workspaceHeight,
  });

  return (
    <>
      {isDraggingSplit && (
        <div className="fixed inset-0 z-[9999] cursor-row-resize bg-transparent" />
      )}
      <div className="h-full min-h-0 overflow-hidden flex flex-col">
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
            {/* 通联程序（有操作员时才显示） */}
            {operators.length > 0 && automationOperatorId && (
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
                <PopoverContent className="overflow-hidden p-0">
                  <div className="max-h-[min(72vh,calc(100vh-5rem))] overflow-y-auto overscroll-contain px-1 py-1">
                    <AutomationSettingsPanel operatorId={automationOperatorId} />
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
            <QSONotificationToggleButton />
            <ThemeToggle variant="dropdown" size="sm" />
            <SettingsButton />
          </div>
        </div>
      </div>
      
      {/* 主内容区域（移动端与桌面端统一：自适应默认 + 可拖拽手动分割 + 双击恢复） */}
      <div className="flex-1 p-2 pt-0 md:p-5 md:pt-0 flex flex-col gap-2 md:gap-4 min-h-0 overflow-hidden">
        <div ref={splitWorkspaceRef} className="flex-1 min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {hasCustomSplit ? (
              <>
                {/* 手动模式：分割比例即顶栏精确高度；底部容器（操作员区 + RadioControl）占据剩余空间 */}
                {/* 拖拽可整体调整底部容器大小，卡片与 RadioControl 间距由拖拽决定，单个操作员时也可消除 */}
                <div
                  ref={topPaneRef}
                  className="relative z-0 min-h-0 overflow-hidden"
                  style={workspaceHeight > 0 ? { height: `${desktopPaneHeights.topPaneHeightPx}px` } : { height: `${splitPercent}%` }}
                >
                  <MyRelatedFramesTable className="h-full" />
                </div>
                <RightLayoutPaneDivider
                  isDragging={isDraggingSplit}
                  onPointerDown={handleSplitPointerDown}
                  onDoubleClick={handleSplitDividerDoubleClick}
                  resetHint={t('rightLayout.resetSplitToAuto')}
                />
                <div className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pt-2 pb-4 [scrollbar-gutter:stable]">
                  <RadioOperatorList onCreateOperator={handleCreateOperator} />
                </div>
                <div className="relative z-10 flex-shrink-0">
                  <RadioControl onOpenRadioSettings={handleOpenRadioSettings} />
                </div>
              </>
            ) : (
              <>
                {/* 默认自适应布局：表格占据剩余空间，底部容器（操作员区 + RadioControl）跟随内容自然高度（上限 70%），同 main 经典行为 */}
                <div ref={topPaneRef} className="relative z-0 flex-1 min-h-0 overflow-hidden">
                  <MyRelatedFramesTable className="h-full" />
                </div>
                <RightLayoutPaneDivider
                  isDragging={isDraggingSplit}
                  onPointerDown={handleSplitPointerDown}
                  onDoubleClick={handleSplitDividerDoubleClick}
                  resetHint={t('rightLayout.resetSplitToAuto')}
                />
                <div className="relative z-10 flex-shrink-0 min-h-0 max-h-[70%] flex flex-col overflow-hidden">
                  {/* 间距与 main 对齐：分割条 8px + pt-2 8px = 16px（原 gap-4）；pb-4 16px 同理 */}
                  <div className="min-h-0 overflow-y-auto overscroll-contain px-1 pt-2 pb-4 [scrollbar-gutter:stable]">
                    <RadioOperatorList onCreateOperator={handleCreateOperator} />
                  </div>
                  <div className="relative z-10 flex-shrink-0">
                    <RadioControl onOpenRadioSettings={handleOpenRadioSettings} />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
};
