import { useState, useEffect, useCallback, useMemo } from 'react';
import { createLogger } from '../../utils/logger';

const logger = createLogger('TokenManagement');
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Radio,
  RadioGroup,
  Checkbox,
  CheckboxGroup,
  Spinner,
  Select,
  SelectItem,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faTrash, faCopy, faCheck, faRotate, faLock, faChevronDown, faShareNodes, faEye, faEyeSlash, faPen } from '@fortawesome/free-solid-svg-icons';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '@tx5dr/core';
import { UserRole, Permission, PERMISSION_GROUPS, CONDITIONAL_PERMISSIONS } from '@tx5dr/contracts';
import type { TokenInfo, CreateTokenRequest, NetworkInfo, PermissionGrant, PresetFrequency, UpdateTokenRequest } from '@tx5dr/contracts';
import { useOperators } from '../../store/radioStore';

const ROLE_COLORS: Record<string, 'default' | 'primary' | 'warning'> = {
  viewer: 'default',
  operator: 'primary',
  admin: 'warning',
};
const CUSTOM_BAND = 'custom';

type CreateLoginCredentialInitMode = 'none' | 'admin' | 'self-service';

function expiryKeyToTimestamp(key: string): number | undefined {
  if (key === 'never') return undefined;
  const days = parseInt(key);
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

interface TokenCardProps {
  token: TokenInfo;
  operators: { id: string; context: { myCall: string; frequency?: number } }[];
  onRevoke: (id: string) => void;
  onRegenerate: (id: string) => void;
  onShare: (token: TokenInfo) => void;
  onEdit: (token: TokenInfo) => void;
}

function TokenCard({ token, operators, onRevoke, onRegenerate, onShare, onEdit }: TokenCardProps) {
  const { t } = useTranslation();
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const roleLabels: Record<string, string> = {
    viewer: t('common:role.viewer'),
    operator: t('common:role.operator'),
    admin: t('common:role.admin'),
  };
  const handleCopyToken = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);
  return (
    <Card className={token.revoked ? 'opacity-50' : ''}>
      <CardBody className="p-3 gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${token.revoked ? 'bg-danger' : 'bg-success'}`} />
            <span className="font-medium text-sm">{token.label}</span>
            <Chip size="sm" variant="flat" color={ROLE_COLORS[token.role]}>
              {roleLabels[token.role]}
            </Chip>
            {token.system && (
              <Chip size="sm" variant="flat" color="default" startContent={<FontAwesomeIcon icon={faLock} className="text-[10px]" />}>
                {t('auth:token.system')}
              </Chip>
            )}
            {token.operatorIds.length > 0 && (
              <span className="text-xs text-default-400">
                {t('auth:token.operatorCount', { count: token.operatorIds.length })}
              </span>
            )}
            {token.maxOperators !== undefined && token.role !== 'admin' && (
              <span className="text-xs text-default-400">
                {t('auth:token.maxOperators', { max: token.maxOperators === 0 ? t('auth:token.unlimited') : token.maxOperators })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {token.token && !token.revoked && (
              <Button
                size="sm"
                variant="flat"
                color="primary"
                isIconOnly
                onPress={() => onShare(token)}
                title={t('auth:token.share')}
              >
                <FontAwesomeIcon icon={faShareNodes} />
              </Button>
            )}
            {token.system && !token.revoked && (
              <Button
                size="sm"
                variant="flat"
                color="warning"
                isIconOnly
                onPress={() => onRegenerate(token.id)}
                title={t('auth:token.regenerate')}
              >
                <FontAwesomeIcon icon={faRotate} />
              </Button>
            )}
            {!token.revoked && (
              <Button
                size="sm"
                variant="flat"
                color="default"
                isIconOnly
                onPress={() => onEdit(token)}
                title={t('auth:token.edit')}
              >
                <FontAwesomeIcon icon={faPen} />
              </Button>
            )}
            {!token.revoked && !token.system && (
              <Button
                size="sm"
                variant="flat"
                color="danger"
                isIconOnly
                onPress={() => onRevoke(token.id)}
                title={t('auth:token.revoke')}
              >
                <FontAwesomeIcon icon={faTrash} />
              </Button>
            )}
          </div>
        </div>
        <div className="text-xs text-default-400 flex gap-3">
          <span>{t('auth:token.createdAt', { date: new Date(token.createdAt).toLocaleDateString() })}</span>
          {token.lastUsedAt && (
            <span>{t('auth:token.lastUsed', { date: new Date(token.lastUsedAt).toLocaleDateString() })}</span>
          )}
          {token.expiresAt && (
            <span>{t('auth:token.expiresAt', { date: new Date(token.expiresAt).toLocaleDateString() })}</span>
          )}
          {token.revoked && <span className="text-danger">{t('auth:token.revoked')}</span>}
        </div>
        {token.operatorIds.length > 0 && (
          <div className="text-xs text-default-500">
            {t('auth:token.operators')}: {token.operatorIds.map((id) => {
              const op = operators.find((o) => o.id === id);
              return op ? `${op.context.myCall}(${op.context.frequency}Hz)` : id;
            }).join(', ')}
          </div>
        )}
        {token.permissionGrants && token.permissionGrants.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {token.permissionGrants.map((grant) => (
              <Chip key={grant.permission} size="sm" variant="flat" color="secondary" className="text-[10px] h-5">
                {t(`auth:permissions.${grant.permission.replace(':', '.')}`)}
              </Chip>
            ))}
          </div>
        )}
        {(token.loginCredential || token.allowSelfLoginCredential) && (
          <div className="flex flex-wrap gap-2 text-xs text-default-500">
            {token.loginCredential && (
              <span>
                {t('auth:token.loginCredential.username')}: {token.loginCredential.username}
              </span>
            )}
            <span>
              {token.allowSelfLoginCredential
                ? t('auth:token.loginCredential.selfServiceEnabled')
                : t('auth:token.loginCredential.selfServiceDisabled')}
            </span>
          </div>
        )}
        {token.token && !token.revoked && (
          <div className="flex items-center gap-1 bg-default-100 rounded-md px-2 py-1.5">
            <code className="flex-1 text-xs break-all text-default-600 select-all">
              {tokenVisible ? token.token : '•'.repeat(Math.min(token.token.length, 32))}
            </code>
            <Button
              size="sm"
              variant="light"
              isIconOnly
              className="min-w-6 w-6 h-6 shrink-0"
              onPress={() => setTokenVisible(v => !v)}
              title={tokenVisible ? t('auth:token.hide') : t('auth:token.show')}
            >
              <FontAwesomeIcon
                icon={tokenVisible ? faEyeSlash : faEye}
                className="text-default-400 text-xs"
              />
            </Button>
            <Button
              size="sm"
              variant="light"
              isIconOnly
              className="min-w-6 w-6 h-6 shrink-0"
              onPress={() => handleCopyToken(token.token!)}
              title={t('auth:token.copy')}
            >
              <FontAwesomeIcon
                icon={tokenCopied ? faCheck : faCopy}
                className={tokenCopied ? 'text-success text-xs' : 'text-default-400 text-xs'}
              />
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function TokenManagement() {
  const { t } = useTranslation();
  const ROLE_LABELS = useMemo(() => ({
    viewer: t('common:role.viewer'),
    operator: t('common:role.operator'),
    admin: t('common:role.admin'),
  }), [t]);
  const EXPIRY_OPTIONS = useMemo(() => [
    { key: 'never', label: t('auth:token.expiryOptions.never') },
    { key: '1d', label: t('auth:token.expiryOptions.1d') },
    { key: '7d', label: t('auth:token.expiryOptions.7d') },
    { key: '30d', label: t('auth:token.expiryOptions.30d') },
    { key: '90d', label: t('auth:token.expiryOptions.90d') },
  ], [t]);
  const { operators } = useOperators();
  const formatBandLabel = useCallback((band?: string | null): string => (
    !band || band.toLowerCase() === CUSTOM_BAND ? t('common:freqPresets.customBand') : band
  ), [t]);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingToken, setEditingToken] = useState<TokenInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  // 分享弹窗状态（创建成功 + 列表分享 共用）
  const [sharingToken, setSharingToken] = useState<TokenInfo | null>(null);
  const [justCreatedTokenValue, setJustCreatedTokenValue] = useState<string | null>(null);
  const [selectedAddressIndex, setSelectedAddressIndex] = useState(0);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);

  // 创建表单状态
  const [newLabel, setNewLabel] = useState('');
  const [newRole, setNewRole] = useState<UserRole>(UserRole.OPERATOR);
  const [newOperatorIds, setNewOperatorIds] = useState<string[]>([]);
  const [newExpiry, setNewExpiry] = useState('never');
  const [newMaxOperators, setNewMaxOperators] = useState('1');
  const [loginCredentialInitMode, setLoginCredentialInitMode] = useState<CreateLoginCredentialInitMode>('none');
  const [loginCredentialUsername, setLoginCredentialUsername] = useState('');
  const [loginCredentialPassword, setLoginCredentialPassword] = useState('');
  const [allowSelfLoginCredential, setAllowSelfLoginCredential] = useState(false);
  const [showCredentialEditor, setShowCredentialEditor] = useState(false);
  const [clearExistingCredential, setClearExistingCredential] = useState(false);
  const [creating, setCreating] = useState(false);

  // 权限授予状态
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [frequencyPresets, setFrequencyPresets] = useState<PresetFrequency[]>([]);
  const [selectedPresetFrequencies, setSelectedPresetFrequencies] = useState<string[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);

  // 加载 Token 列表
  const loadTokens = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api.getTokens();
      setTokens(list);
    } catch (err) {
      logger.error('Failed to load token list:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
    api.getNetworkInfo().then(setNetworkInfo).catch(() => {});
  }, [loadTokens]);

  // 当弹窗打开且选中了频率权限时，加载频率预设
  useEffect(() => {
    if (!createModalOpen || !selectedPermissions.includes(Permission.RADIO_SET_FREQUENCY)) return;
    if (frequencyPresets.length > 0) return; // already loaded
    setPresetsLoading(true);
    api.getPresetFrequencies()
      .then((resp) => setFrequencyPresets(resp.presets))
      .catch(() => {})
      .finally(() => setPresetsLoading(false));
  }, [createModalOpen, selectedPermissions, frequencyPresets.length]);

  // 构建 permissionGrants
  const buildPermissionGrants = useCallback((): PermissionGrant[] | undefined => {
    if (selectedPermissions.length === 0) return undefined;
    return selectedPermissions.map((p) => {
      const grant: PermissionGrant = { permission: p as Permission };
      const condDef = CONDITIONAL_PERMISSIONS[p as Permission];
      if (condDef && p === Permission.RADIO_SET_FREQUENCY && selectedPresetFrequencies.length > 0) {
        grant.conditions = {
          [condDef.conditionField]: {
            [condDef.conditionOperator]: selectedPresetFrequencies.map(Number),
          },
        };
      }
      return grant;
    });
  }, [selectedPermissions, selectedPresetFrequencies]);

  const isCreateAdminCredentialMode = !editingToken && loginCredentialInitMode === 'admin';
  const isEditingConfiguredCredential = Boolean(editingToken?.loginCredential) && !clearExistingCredential;
  const isEditingAdminCredentialMode = Boolean(editingToken) && (showCredentialEditor || isEditingConfiguredCredential);
  const shouldShowCredentialInputs = isCreateAdminCredentialMode || isEditingAdminCredentialMode;
  const isCredentialUsernameValid = loginCredentialUsername.trim().length >= 3;
  const isCredentialPasswordValid = loginCredentialPassword.length === 0 || loginCredentialPassword.length >= 8;
  const isCredentialFormValid = !shouldShowCredentialInputs
    || (isCredentialUsernameValid
      && isCredentialPasswordValid
      && (editingToken?.loginCredential ? true : loginCredentialPassword.length >= 8));

  // 关闭创建/编辑 Modal 并重置表单
  const closeFormModal = useCallback(() => {
    setCreateModalOpen(false);
    setEditingToken(null);
    setNewLabel('');
    setNewRole(UserRole.OPERATOR);
    setNewOperatorIds([]);
    setNewExpiry('never');
    setNewMaxOperators('1');
    setLoginCredentialInitMode('none');
    setLoginCredentialUsername('');
    setLoginCredentialPassword('');
    setAllowSelfLoginCredential(false);
    setShowCredentialEditor(false);
    setClearExistingCredential(false);
    setSelectedPermissions([]);
    setSelectedPresetFrequencies([]);
  }, []);

  // 创建 Token
  const handleCreate = useCallback(async () => {
    if (!newLabel.trim()) return;
    if (loginCredentialInitMode === 'admin' && (!loginCredentialUsername.trim() || loginCredentialPassword.length < 8)) {
      addToast({
        title: t('auth:token.loginCredential.validationFailed'),
        description: t('auth:token.loginCredential.passwordRequiredForCreate'),
        color: 'danger',
        timeout: 4000,
      });
      return;
    }
    setCreating(true);
    try {
      const permissionGrants = newRole === UserRole.OPERATOR ? buildPermissionGrants() : undefined;
      const req: CreateTokenRequest = {
        label: newLabel.trim(),
        role: newRole,
        operatorIds: newRole === UserRole.ADMIN ? [] : newOperatorIds,
        expiresAt: expiryKeyToTimestamp(newExpiry),
        maxOperators: parseInt(newMaxOperators) || 1,
        allowSelfLoginCredential: loginCredentialInitMode === 'self-service'
          ? true
          : loginCredentialInitMode === 'admin'
            ? allowSelfLoginCredential
            : false,
        ...(permissionGrants ? { permissionGrants } : {}),
        ...(loginCredentialInitMode === 'admin' ? {
          loginCredential: {
            username: loginCredentialUsername.trim(),
            password: loginCredentialPassword,
          },
        } : {}),
      };
      const resp = await api.createToken(req);
      closeFormModal();
      await loadTokens();
      // 打开分享弹窗，附带刚创建的 token 明文
      setSharingToken({
        id: resp.id,
        token: resp.token,
        label: resp.label,
        role: resp.role,
        operatorIds: resp.operatorIds,
        maxOperators: resp.maxOperators,
        permissionGrants: resp.permissionGrants,
        allowSelfLoginCredential: resp.allowSelfLoginCredential,
        loginCredential: resp.loginCredential,
        createdBy: null,
        createdAt: Date.now(),
        revoked: false,
      });
      setJustCreatedTokenValue(resp.token);
      setSelectedAddressIndex(0);
      setShareLinkCopied(false);
    } catch (err) {
      addToast({
        title: t('auth:token.createFailed'),
        description: typeof err === 'object' && err !== null && 'userMessage' in err && typeof err.userMessage === 'string'
          ? err.userMessage
          : err instanceof Error ? err.message : t('errors:code.UNKNOWN_ERROR.userMessage'),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setCreating(false);
    }
  }, [allowSelfLoginCredential, buildPermissionGrants, closeFormModal, loadTokens, loginCredentialInitMode, loginCredentialPassword, loginCredentialUsername, newExpiry, newLabel, newMaxOperators, newOperatorIds, newRole, t]);

  // 打开编辑 Modal（复用创建 Modal 的表单状态）
  const handleEdit = useCallback((token: TokenInfo) => {
    setEditingToken(token);
    setNewLabel(token.label);
    setNewRole(token.role as UserRole);
    setNewOperatorIds(token.operatorIds);
    setNewMaxOperators(String(token.maxOperators ?? 1));
    setLoginCredentialInitMode('none');
    setLoginCredentialUsername(token.loginCredential?.username ?? '');
    setLoginCredentialPassword('');
    setAllowSelfLoginCredential(token.allowSelfLoginCredential ?? false);
    setShowCredentialEditor(false);
    setClearExistingCredential(false);
    // 从现有 permissionGrants 恢复选中的权限和频率条件
    const perms = (token.permissionGrants ?? []).map(g => g.permission);
    setSelectedPermissions(perms);
    const freqGrant = (token.permissionGrants ?? []).find(g => g.permission === Permission.RADIO_SET_FREQUENCY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const freqIn = (freqGrant?.conditions as any)?.frequency?.['$in'] as number[] | undefined;
    setSelectedPresetFrequencies(freqIn ? freqIn.map(String) : []);
    // expiry: 编辑时不改变已有过期时间，显示为 "never"（保持不变）
    setNewExpiry('never');
    setCreateModalOpen(true);
  }, []);

  // 更新 Token
  const handleUpdate = useCallback(async () => {
    if (!editingToken || !newLabel.trim()) return;
    if (shouldShowCredentialInputs && !loginCredentialUsername.trim()) {
      addToast({
        title: t('auth:token.loginCredential.validationFailed'),
        description: t('auth:token.loginCredential.usernameRequired'),
        color: 'danger',
        timeout: 4000,
      });
      return;
    }
    if (showCredentialEditor && !editingToken.loginCredential && loginCredentialPassword.length < 8) {
      addToast({
        title: t('auth:token.loginCredential.validationFailed'),
        description: t('auth:token.loginCredential.passwordRequiredForCreate'),
        color: 'danger',
        timeout: 4000,
      });
      return;
    }
    if (shouldShowCredentialInputs && loginCredentialPassword.length > 0 && loginCredentialPassword.length < 8) {
      addToast({
        title: t('auth:token.loginCredential.validationFailed'),
        description: t('auth:token.loginCredential.passwordTooShort'),
        color: 'danger',
        timeout: 4000,
      });
      return;
    }
    setCreating(true);
    try {
      const permissionGrants = newRole === UserRole.OPERATOR ? (buildPermissionGrants() ?? null) : null;
      const req: UpdateTokenRequest = {
        label: newLabel.trim(),
        role: newRole,
        operatorIds: newRole === UserRole.ADMIN ? [] : newOperatorIds,
        maxOperators: parseInt(newMaxOperators) || 1,
        allowSelfLoginCredential,
        permissionGrants,
        ...(clearExistingCredential
          ? { loginCredential: null }
          : shouldShowCredentialInputs
          ? {
            loginCredential: {
              username: loginCredentialUsername.trim(),
              ...(loginCredentialPassword ? { password: loginCredentialPassword } : {}),
            },
          }
          : {}),
      };
      await api.updateToken(editingToken.id, req);
      addToast({ title: t('auth:token.updateSuccess'), color: 'success', timeout: 3000 });
      closeFormModal();
      await loadTokens();
    } catch (err) {
      addToast({
        title: t('auth:token.updateFailed'),
        description: typeof err === 'object' && err !== null && 'userMessage' in err && typeof err.userMessage === 'string'
          ? err.userMessage
          : err instanceof Error ? err.message : t('errors:code.UNKNOWN_ERROR.userMessage'),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setCreating(false);
    }
  }, [allowSelfLoginCredential, buildPermissionGrants, clearExistingCredential, closeFormModal, editingToken, loadTokens, loginCredentialPassword, loginCredentialUsername, newLabel, newMaxOperators, newOperatorIds, newRole, shouldShowCredentialInputs, showCredentialEditor, t]);

  // 撤销 Token
  const handleRevoke = useCallback(async (tokenId: string) => {
    try {
      await api.revokeToken(tokenId);
      addToast({ title: t('auth:token.revokeSuccess'), color: 'success', timeout: 3000 });
      await loadTokens();
    } catch (err) {
      addToast({
        title: t('auth:token.revokeFailed'),
        description: err instanceof Error ? err.message : t('errors:code.UNKNOWN_ERROR.userMessage'),
        color: 'danger',
        timeout: 5000,
      });
    }
  }, [loadTokens, t]);

  // 重新生成系统令牌
  const handleRegenerate = useCallback(async (tokenId: string) => {
    try {
      const resp = await api.regenerateToken(tokenId);
      addToast({ title: t('auth:token.regenerated'), color: 'success', timeout: 3000 });
      await loadTokens();
      // 打开分享弹窗，显示新生成的令牌
      setSharingToken({
        id: resp.id,
        token: resp.token,
        label: resp.label,
        role: resp.role,
        operatorIds: resp.operatorIds,
        maxOperators: resp.maxOperators,
        permissionGrants: resp.permissionGrants,
        allowSelfLoginCredential: resp.allowSelfLoginCredential,
        loginCredential: resp.loginCredential,
        createdBy: null,
        createdAt: Date.now(),
        revoked: false,
      });
      setJustCreatedTokenValue(resp.token);
      setSelectedAddressIndex(0);
      setShareLinkCopied(false);
    } catch (err) {
      addToast({
        title: t('auth:token.regenerateFailed'),
        description: err instanceof Error ? err.message : t('errors:code.UNKNOWN_ERROR.userMessage'),
        color: 'danger',
        timeout: 5000,
      });
    }
  }, [loadTokens]);

  // 分享 token
  const handleShare = useCallback((token: TokenInfo) => {
    setSharingToken(token);
    setJustCreatedTokenValue(null);
    setSelectedAddressIndex(0);
    setShareLinkCopied(false);
  }, []);

  const shareUrl = useMemo(() => {
    if (!sharingToken?.token || !networkInfo || networkInfo.addresses.length === 0) return '';
    const base = networkInfo.addresses[selectedAddressIndex]?.url ?? networkInfo.addresses[0].url;
    return `${base}?auth_token=${encodeURIComponent(sharingToken.token)}`;
  }, [sharingToken, networkInfo, selectedAddressIndex]);

  const closeShareModal = useCallback(() => {
    setSharingToken(null);
    setJustCreatedTokenValue(null);
  }, []);

  const handleCopyShareLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareLinkCopied(true);
      setTimeout(() => setShareLinkCopied(false), 2000);
    } catch {
      addToast({ title: t('auth:token.copyFailed'), color: 'danger', timeout: 2000 });
    }
  }, [shareUrl, t]);

  // 复制到剪贴板
  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast({ title: t('auth:token.copyFailed'), color: 'danger', timeout: 2000 });
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{t('auth:token.title')}</h3>
        <Button
          size="sm"
          color="primary"
          startContent={<FontAwesomeIcon icon={faPlus} />}
          onPress={() => setCreateModalOpen(true)}
        >
          {t('auth:token.createNew')}
        </Button>
      </div>

      {/* Token 列表 */}
      {(() => {
        const activeTokens = tokens.filter(t => !t.revoked);
        const revokedTokens = tokens.filter(t => t.revoked);

        return (
          <div className="space-y-2">
            {tokens.length === 0 && (
              <p className="text-default-400 text-sm text-center py-8">{t('auth:token.noTokens')}</p>
            )}
            {activeTokens.map((token) => (
              <TokenCard
                key={token.id}
                token={token}
                operators={operators}
                onRevoke={handleRevoke}
                onRegenerate={handleRegenerate}
                onShare={handleShare}
                onEdit={handleEdit}
              />
            ))}
            {revokedTokens.length > 0 && (
              <>
                <button
                  className="flex items-center gap-2 text-xs text-default-400 hover:text-default-600 transition-colors py-1 cursor-pointer"
                  onClick={() => setShowRevoked(!showRevoked)}
                >
                  <FontAwesomeIcon
                    icon={faChevronDown}
                    className={`transition-transform text-[10px] ${showRevoked ? '' : '-rotate-90'}`}
                  />
                  <span>{t('auth:token.revokedList', { count: revokedTokens.length })}</span>
                </button>
                {showRevoked && revokedTokens.map((token) => (
                  <TokenCard
                    key={token.id}
                    token={token}
                    operators={operators}
                    onRevoke={handleRevoke}
                    onRegenerate={handleRegenerate}
                    onShare={handleShare}
                    onEdit={handleEdit}
                  />
                ))}
              </>
            )}
          </div>
        );
      })()}

      {/* 创建 Token 弹窗 */}
      <Modal isOpen={createModalOpen} onClose={closeFormModal} size="lg" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>{editingToken ? t('auth:token.editModal.title') : t('auth:token.createModal.title')}</ModalHeader>
          <ModalBody className="gap-4">
            <Input
              size="sm"
              label={t('auth:token.createModal.labelName')}
              placeholder={t('auth:token.createModal.labelPlaceholder')}
              value={newLabel}
              onValueChange={setNewLabel}
              isRequired
            />
            {/* 角色 */}
            <div>
              <p className="text-sm font-medium">{t('auth:token.createModal.roleLabel')}</p>
              <p className="text-xs text-default-400 mb-2">{t('auth:token.createModal.roleDesc')}</p>
              <div className="border border-default-200 rounded-lg p-3">
                <RadioGroup
                  size="sm"
                  value={newRole}
                  onValueChange={(v) => setNewRole(v as UserRole)}
                  isDisabled={!!editingToken?.system}
                >
                  <Radio value={UserRole.VIEWER} description={t('auth:token.createModal.roleViewerDesc')}>{t('auth:token.createModal.roleViewer')}</Radio>
                  <Radio value={UserRole.OPERATOR} description={t('auth:token.createModal.roleOperatorDesc')}>{t('auth:token.createModal.roleOperator')}</Radio>
                  <Radio value={UserRole.ADMIN} description={t('auth:token.createModal.roleAdminDesc')}>{t('auth:token.createModal.roleAdmin')}</Radio>
                </RadioGroup>
              </div>
            </div>

            {/* 授权操作员 */}
            {newRole !== UserRole.ADMIN && operators.length > 0 && (
              <div>
                <p className="text-sm font-medium">{t('auth:token.createModal.authorizedOperators')}</p>
                <p className="text-xs text-default-400 mb-2">{t('auth:token.createModal.authorizedOperatorsDesc')}</p>
                <div className="border border-default-200 rounded-lg p-3">
                  <CheckboxGroup
                    size="sm"
                    value={newOperatorIds}
                    onValueChange={setNewOperatorIds}
                  >
                    {operators.map((op) => (
                      <Checkbox key={op.id} value={op.id}>
                        {op.context.myCall} ({op.context.frequency} Hz)
                      </Checkbox>
                    ))}
                  </CheckboxGroup>
                </div>
              </div>
            )}

            <div>
              <p className="text-sm font-medium">{t('auth:token.loginCredential.sectionTitle')}</p>
              <p className="text-xs text-default-400 mb-2">{t('auth:token.loginCredential.sectionDesc')}</p>
              <div className="border border-default-200 rounded-lg p-3 space-y-3">
                {!editingToken ? (
                  <>
                    <RadioGroup
                      size="sm"
                      value={loginCredentialInitMode}
                      onValueChange={(value) => setLoginCredentialInitMode(value as CreateLoginCredentialInitMode)}
                    >
                      <Radio value="none" description={t('auth:token.loginCredential.initNoneDesc')}>
                        {t('auth:token.loginCredential.initNone')}
                      </Radio>
                      <Radio value="admin" description={t('auth:token.loginCredential.initAdminDesc')}>
                        {t('auth:token.loginCredential.initAdmin')}
                      </Radio>
                      <Radio value="self-service" description={t('auth:token.loginCredential.initSelfServiceDesc')}>
                        {t('auth:token.loginCredential.initSelfService')}
                      </Radio>
                    </RadioGroup>

                    {loginCredentialInitMode === 'admin' && (
                      <>
                        <Input
                          size="sm"
                          label={t('auth:token.loginCredential.usernameLabel')}
                          placeholder={t('auth:token.loginCredential.usernamePlaceholder')}
                          value={loginCredentialUsername}
                          onValueChange={setLoginCredentialUsername}
                        />
                        <Input
                          size="sm"
                          type="password"
                          label={t('auth:token.loginCredential.passwordLabel')}
                          placeholder={t('auth:token.loginCredential.passwordPlaceholderRequired')}
                          description={t('auth:token.loginCredential.passwordDescriptionRequired')}
                          value={loginCredentialPassword}
                          onValueChange={setLoginCredentialPassword}
                        />
                        <Checkbox
                          size="sm"
                          isSelected={allowSelfLoginCredential}
                          onValueChange={setAllowSelfLoginCredential}
                        >
                          {t('auth:token.loginCredential.allowSelfService')}
                        </Checkbox>
                      </>
                    )}

                    {loginCredentialInitMode === 'self-service' && (
                      <p className="text-xs text-default-500">
                        {t('auth:token.loginCredential.selfServiceInitHint')}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="rounded-lg bg-content2 px-3 py-2 text-xs text-default-600 space-y-1">
                      <p>
                        {editingToken.loginCredential && !clearExistingCredential
                          ? t('auth:token.loginCredential.statusConfigured', { username: editingToken.loginCredential.username })
                          : t('auth:token.loginCredential.statusNotConfigured')}
                      </p>
                      <p className="text-default-500">
                        {(allowSelfLoginCredential
                          ? t('auth:token.loginCredential.selfServiceEnabledHint')
                          : t('auth:token.loginCredential.selfServiceDisabledHint'))}
                      </p>
                    </div>

                    <Checkbox
                      size="sm"
                      isSelected={allowSelfLoginCredential}
                      onValueChange={setAllowSelfLoginCredential}
                    >
                      {t('auth:token.loginCredential.allowSelfService')}
                    </Checkbox>

                    {shouldShowCredentialInputs ? (
                      <>
                        <Input
                          size="sm"
                          label={t('auth:token.loginCredential.usernameLabel')}
                          placeholder={t('auth:token.loginCredential.usernamePlaceholder')}
                          value={loginCredentialUsername}
                          onValueChange={setLoginCredentialUsername}
                        />
                        <Input
                          size="sm"
                          type="password"
                          label={t('auth:token.loginCredential.passwordLabel')}
                          placeholder={editingToken.loginCredential
                            ? t('auth:token.loginCredential.passwordPlaceholderOptional')
                            : t('auth:token.loginCredential.passwordPlaceholderRequired')}
                          description={editingToken.loginCredential
                            ? t('auth:token.loginCredential.passwordDescriptionOptional')
                            : t('auth:token.loginCredential.passwordDescriptionRequired')}
                          value={loginCredentialPassword}
                          onValueChange={setLoginCredentialPassword}
                        />
                        {editingToken.loginCredential && !clearExistingCredential && (
                          <Button
                            size="sm"
                            variant="flat"
                            color="danger"
                            onPress={() => {
                              setClearExistingCredential(true);
                              setShowCredentialEditor(false);
                              setLoginCredentialUsername('');
                              setLoginCredentialPassword('');
                            }}
                          >
                            {t('auth:token.loginCredential.clearAction')}
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="flat"
                        onPress={() => {
                          setShowCredentialEditor(true);
                          setClearExistingCredential(false);
                        }}
                      >
                        {t('auth:token.loginCredential.setNowAction')}
                      </Button>
                    )}

                    {clearExistingCredential && (
                      <p className="text-xs text-warning">
                        {t('auth:token.loginCredential.clearHint')}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* 额外权限（仅 OPERATOR 角色显示） */}
            {newRole === UserRole.OPERATOR && (
              <div>
                <p className="text-sm font-medium">{t('auth:permissions.title')}</p>
                <p className="text-xs text-default-400 mb-2">{t('auth:permissions.description')}</p>
                <div className="border border-default-200 rounded-lg p-3 space-y-3">
                  {PERMISSION_GROUPS.map((group) => (
                    <div key={group.key}>
                      <p className="text-xs text-default-500 font-medium mb-1.5">{t(`auth:permissions.group.${group.key}`)}</p>
                      <div className="flex flex-col gap-1 pl-1">
                        {group.permissions.map((perm) => (
                          <div key={perm}>
                            <Checkbox
                              size="sm"
                              isSelected={selectedPermissions.includes(perm)}
                              onValueChange={(checked) => {
                                if (checked) {
                                  setSelectedPermissions((prev) => [...prev, perm]);
                                } else {
                                  setSelectedPermissions((prev) => prev.filter((p) => p !== perm));
                                  if (perm === Permission.RADIO_SET_FREQUENCY) {
                                    setSelectedPresetFrequencies([]);
                                  }
                                }
                              }}
                            >
                              <span className="text-sm">{t(`auth:permissions.${perm.replace(':', '.')}`)}</span>
                            </Checkbox>
                            {/* 频率限制条件编辑器 */}
                            {perm === Permission.RADIO_SET_FREQUENCY && selectedPermissions.includes(perm) && (
                              <div className="pl-7 pt-1 pb-1">
                                <p className="text-xs text-default-400 mb-1.5">{t('auth:permissions.frequencyRestriction')}</p>
                                {presetsLoading ? (
                                  <Spinner size="sm" />
                                ) : frequencyPresets.length > 0 ? (
                                  <CheckboxGroup
                                    size="sm"
                                    value={selectedPresetFrequencies}
                                    onValueChange={setSelectedPresetFrequencies}
                                  >
                                    {frequencyPresets.map((preset) => (
                                      <Checkbox key={String(preset.frequency)} value={String(preset.frequency)}>
                                        <span className="text-xs">{preset.description || `${(preset.frequency / 1e6).toFixed(3)} MHz`} — {formatBandLabel(preset.band)} {preset.mode}</span>
                                      </Checkbox>
                                    ))}
                                  </CheckboxGroup>
                                ) : null}
                                <p className="text-xs text-default-300 mt-1">
                                  {selectedPresetFrequencies.length === 0
                                    ? t('auth:permissions.allPresets')
                                    : t('auth:permissions.selectedPresets', { count: selectedPresetFrequencies.length })}
                                </p>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!editingToken && (
              <Select
                size="sm"
                label={t('auth:token.createModal.expiryLabel')}
                selectedKeys={new Set([newExpiry])}
                onSelectionChange={(keys) => {
                  const arr = Array.from(keys);
                  if (arr.length > 0) setNewExpiry(arr[0] as string);
                }}
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.key}>{opt.label}</SelectItem>
                ))}
              </Select>
            )}

            {newRole !== UserRole.ADMIN && (
              <Input
                size="sm"
                type="number"
                label={t('auth:token.createModal.maxOperatorsLabel')}
                description={t('auth:token.createModal.maxOperatorsDesc')}
                value={newMaxOperators}
                onValueChange={setNewMaxOperators}
                min={0}
              />
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={closeFormModal}>{t('common:button.cancel')}</Button>
            <Button
              color="primary"
              onPress={editingToken ? handleUpdate : handleCreate}
              isLoading={creating}
              isDisabled={!newLabel.trim() || !isCredentialFormValid}
            >
              {editingToken ? t('common:button.save') : t('auth:token.create')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 分享 / 创建成功 弹窗（合并） */}
      <Modal isOpen={!!sharingToken} onClose={closeShareModal} size="md">
        <ModalContent>
          <ModalHeader>{justCreatedTokenValue ? t('auth:token.created.title') : t('auth:token.shareModal.title')}</ModalHeader>
          <ModalBody className="gap-4">
            {/* 创建成功时显示令牌明文 */}
            {justCreatedTokenValue && (
              <>
                <p className="text-sm text-default-600">{t('auth:token.created.warning')}</p>
                <div className="flex items-center gap-2 bg-default-100 rounded-lg p-3">
                  <code className="flex-1 text-sm break-all">{justCreatedTokenValue}</code>
                  <Button
                    size="sm"
                    variant="flat"
                    isIconOnly
                    onPress={() => handleCopy(justCreatedTokenValue)}
                    title={t('auth:token.copy')}
                  >
                    <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
                  </Button>
                </div>
                <div className="text-xs text-default-400">
                  <p>{t('auth:token.created.labelInfo', { label: sharingToken?.label })}</p>
                  <p>{t('auth:token.created.roleInfo', { role: sharingToken?.role ? ROLE_LABELS[sharingToken.role] : '' })}</p>
                  {sharingToken?.operatorIds && sharingToken.operatorIds.length > 0 && (
                    <p>{t('auth:token.created.operatorsInfo', { ids: sharingToken.operatorIds.join(', ') })}</p>
                  )}
                </div>
              </>
            )}

            {!justCreatedTokenValue && (
              <p className="text-sm text-default-500">{t('auth:token.shareModal.desc')}</p>
            )}

            {/* 地址选择（多网卡时显示） */}
            {networkInfo && networkInfo.addresses.length > 1 && (
              <Select
                label={t('auth:token.shareModal.selectAddress')}
                selectedKeys={new Set([String(selectedAddressIndex)])}
                onSelectionChange={(keys) => {
                  const arr = Array.from(keys);
                  if (arr.length > 0) setSelectedAddressIndex(Number(arr[0]));
                }}
                size="sm"
              >
                {networkInfo.addresses.map((addr, i) => (
                  <SelectItem key={String(i)}>{addr.url}</SelectItem>
                ))}
              </Select>
            )}

            {/* QR 码 + 分享链接 */}
            {shareUrl ? (
              <div className="flex flex-col items-center gap-3">
                <div className="bg-white p-4 rounded-xl shadow-sm">
                  <QRCodeSVG value={shareUrl} size={200} />
                </div>
                <div className="flex items-center gap-2 w-full bg-default-100 rounded-lg px-3 py-2">
                  <code className="flex-1 text-xs break-all text-default-600">{shareUrl}</code>
                  <Button
                    size="sm"
                    variant="light"
                    isIconOnly
                    className="min-w-6 w-6 h-6 shrink-0"
                    onPress={handleCopyShareLink}
                    title={t('auth:token.shareModal.copyLink')}
                  >
                    <FontAwesomeIcon
                      icon={shareLinkCopied ? faCheck : faCopy}
                      className={shareLinkCopied ? 'text-success text-xs' : 'text-default-400 text-xs'}
                    />
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-warning-600 text-center py-4">{t('auth:token.shareModal.noToken')}</p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              color="primary"
              variant="flat"
              startContent={<FontAwesomeIcon icon={shareLinkCopied ? faCheck : faCopy} />}
              onPress={handleCopyShareLink}
              isDisabled={!shareUrl}
            >
              {shareLinkCopied ? t('auth:token.shareModal.linkCopied') : t('auth:token.shareModal.copyLink')}
            </Button>
            <Button color="primary" onPress={closeShareModal}>{t('auth:token.created.done')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
