import { useState, useEffect, useCallback, useMemo } from 'react';
import { createLogger } from '../utils/logger';

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
import { faPlus, faTrash, faCopy, faCheck, faRotate, faLock, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import { UserRole } from '@tx5dr/contracts';
import type { TokenInfo, CreateTokenRequest, CreateTokenResponse, NetworkInfo } from '@tx5dr/contracts';
import { useOperators } from '../store/radioStore';

const ROLE_COLORS: Record<string, 'default' | 'primary' | 'warning'> = {
  viewer: 'default',
  operator: 'primary',
  admin: 'warning',
};

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
}

function TokenCard({ token, operators, onRevoke, onRegenerate }: TokenCardProps) {
  const { t } = useTranslation();
  const roleLabels: Record<string, string> = {
    viewer: t('common:role.viewer'),
    operator: t('common:role.operator'),
    admin: t('common:role.admin'),
  };
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
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreateTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);

  // 创建表单状态
  const [newLabel, setNewLabel] = useState('');
  const [newRole, setNewRole] = useState<UserRole>(UserRole.OPERATOR);
  const [newOperatorIds, setNewOperatorIds] = useState<string[]>([]);
  const [newExpiry, setNewExpiry] = useState('never');
  const [newMaxOperators, setNewMaxOperators] = useState('1');
  const [creating, setCreating] = useState(false);

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
  }, [loadTokens]);

  // 创建 token 成功后加载网络信息
  useEffect(() => {
    if (!createdToken) return;
    api.getNetworkInfo().then(setNetworkInfo).catch(() => {});
  }, [createdToken]);

  // 创建 Token
  const handleCreate = useCallback(async () => {
    if (!newLabel.trim()) return;
    setCreating(true);
    try {
      const req: CreateTokenRequest = {
        label: newLabel.trim(),
        role: newRole,
        operatorIds: newRole === UserRole.ADMIN ? [] : newOperatorIds,
        expiresAt: expiryKeyToTimestamp(newExpiry),
        maxOperators: parseInt(newMaxOperators) || 1,
      };
      const resp = await api.createToken(req);
      setCreatedToken(resp);
      setCreateModalOpen(false);
      // 重置表单
      setNewLabel('');
      setNewRole(UserRole.OPERATOR);
      setNewOperatorIds([]);
      setNewExpiry('never');
      setNewMaxOperators('1');
      await loadTokens();
    } catch (err) {
      addToast({
        title: t('auth:token.createFailed'),
        description: err instanceof Error ? err.message : t('errors:code.UNKNOWN_ERROR.userMessage'),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setCreating(false);
    }
  }, [newLabel, newRole, newOperatorIds, newExpiry, newMaxOperators, loadTokens]);

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
      setCreatedToken(resp);
      addToast({ title: t('auth:token.regenerated'), color: 'success', timeout: 3000 });
      await loadTokens();
    } catch (err) {
      addToast({
        title: t('auth:token.regenerateFailed'),
        description: err instanceof Error ? err.message : t('errors:code.UNKNOWN_ERROR.userMessage'),
        color: 'danger',
        timeout: 5000,
      });
    }
  }, [loadTokens]);

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
                  />
                ))}
              </>
            )}
          </div>
        );
      })()}

      {/* 创建 Token 弹窗 */}
      <Modal isOpen={createModalOpen} onClose={() => setCreateModalOpen(false)} size="md">
        <ModalContent>
          <ModalHeader>{t('auth:token.createModal.title')}</ModalHeader>
          <ModalBody className="gap-4">
            <Input
              label={t('auth:token.createModal.labelName')}
              placeholder={t('auth:token.createModal.labelPlaceholder')}
              value={newLabel}
              onValueChange={setNewLabel}
              isRequired
            />
            <RadioGroup
              label={t('auth:token.createModal.roleLabel')}
              value={newRole}
              onValueChange={(v) => setNewRole(v as UserRole)}
            >
              <Radio value={UserRole.VIEWER} description={t('auth:token.createModal.roleViewerDesc')}>{t('auth:token.createModal.roleViewer')}</Radio>
              <Radio value={UserRole.OPERATOR} description={t('auth:token.createModal.roleOperatorDesc')}>{t('auth:token.createModal.roleOperator')}</Radio>
              <Radio value={UserRole.ADMIN} description={t('auth:token.createModal.roleAdminDesc')}>{t('auth:token.createModal.roleAdmin')}</Radio>
            </RadioGroup>

            {newRole !== UserRole.ADMIN && operators.length > 0 && (
              <CheckboxGroup
                label={t('auth:token.createModal.authorizedOperators')}
                value={newOperatorIds}
                onValueChange={setNewOperatorIds}
              >
                {operators.map((op) => (
                  <Checkbox key={op.id} value={op.id}>
                    {op.context.myCall} ({op.context.frequency} Hz)
                  </Checkbox>
                ))}
              </CheckboxGroup>
            )}

            <Select
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

            {newRole !== UserRole.ADMIN && (
              <Input
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
            <Button variant="flat" onPress={() => setCreateModalOpen(false)}>{t('common:button.cancel')}</Button>
            <Button
              color="primary"
              onPress={handleCreate}
              isLoading={creating}
              isDisabled={!newLabel.trim()}
            >
              {t('auth:token.create')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 创建成功弹窗 */}
      <Modal isOpen={!!createdToken} onClose={() => setCreatedToken(null)} size="md">
        <ModalContent>
          <ModalHeader>{t('auth:token.created.title')}</ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm text-default-600">
              {t('auth:token.created.warning')}
            </p>
            <div className="flex items-center gap-2 bg-default-100 rounded-lg p-3">
              <code className="flex-1 text-sm break-all">{createdToken?.token}</code>
              <Button
                size="sm"
                variant="flat"
                isIconOnly
                onPress={() => handleCopy(createdToken?.token || '')}
                title={t('auth:token.copy')}
              >
                <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
              </Button>
            </div>
            <div className="text-xs text-default-400">
              <p>{t('auth:token.created.labelInfo', { label: createdToken?.label })}</p>
              <p>{t('auth:token.created.roleInfo', { role: createdToken?.role ? ROLE_LABELS[createdToken.role] : '' })}</p>
              {createdToken?.operatorIds && createdToken.operatorIds.length > 0 && (
                <p>{t('auth:token.created.operatorsInfo', { ids: createdToken.operatorIds.join(', ') })}</p>
              )}
            </div>
            {/* 远程访问地址提示 */}
            {networkInfo && networkInfo.addresses.length > 0 && (
              <div className="border-t border-divider pt-3 mt-1">
                <p className="text-xs text-default-400 font-medium mb-1.5">
                  {t('auth:token.created.howToUse')}
                </p>
                <p className="text-xs text-default-400 mb-2">
                  {t('auth:token.created.howToUseDesc')}
                </p>
                <div className="flex items-center gap-1.5 bg-default-100 rounded-md px-2 py-1.5">
                  <code className="flex-1 text-xs text-default-600 truncate">
                    {networkInfo.addresses[0].url}
                  </code>
                  <Button
                    size="sm"
                    variant="light"
                    isIconOnly
                    className="min-w-6 w-6 h-6"
                    onPress={async () => {
                      try {
                        await navigator.clipboard.writeText(networkInfo.addresses[0].url);
                        setUrlCopied(true);
                        setTimeout(() => setUrlCopied(false), 2000);
                      } catch { /* ignore */ }
                    }}
                    title={t('common:remoteAccess.copyLink')}
                  >
                    <FontAwesomeIcon
                      icon={urlCopied ? faCheck : faCopy}
                      className={urlCopied ? 'text-success text-xs' : 'text-default-400 text-xs'}
                    />
                  </Button>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button color="primary" onPress={() => setCreatedToken(null)}>{t('auth:token.created.done')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
