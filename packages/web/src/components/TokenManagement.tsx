import { useState, useEffect, useCallback } from 'react';
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
import type { TokenInfo, CreateTokenRequest, CreateTokenResponse } from '@tx5dr/contracts';
import { useOperators } from '../store/radioStore';

const ROLE_LABELS: Record<string, string> = {
  viewer: '查看者',
  operator: '操作员',
  admin: '管理员',
};

const ROLE_COLORS: Record<string, 'default' | 'primary' | 'warning'> = {
  viewer: 'default',
  operator: 'primary',
  admin: 'warning',
};

const EXPIRY_OPTIONS = [
  { key: 'never', label: '永久有效' },
  { key: '1d', label: '1 天' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: '90d', label: '90 天' },
];

function expiryKeyToTimestamp(key: string): number | undefined {
  if (key === 'never') return undefined;
  const days = parseInt(key);
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

interface TokenCardProps {
  token: TokenInfo;
  operators: { id: string; context: { myCall: string; txFrequency: number } }[];
  onRevoke: (id: string) => void;
  onRegenerate: (id: string) => void;
}

function TokenCard({ token, operators, onRevoke, onRegenerate }: TokenCardProps) {
  return (
    <Card className={token.revoked ? 'opacity-50' : ''}>
      <CardBody className="p-3 gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${token.revoked ? 'bg-danger' : 'bg-success'}`} />
            <span className="font-medium text-sm">{token.label}</span>
            <Chip size="sm" variant="flat" color={ROLE_COLORS[token.role]}>
              {ROLE_LABELS[token.role]}
            </Chip>
            {token.system && (
              <Chip size="sm" variant="flat" color="default" startContent={<FontAwesomeIcon icon={faLock} className="text-[10px]" />}>
                系统
              </Chip>
            )}
            {token.operatorIds.length > 0 && (
              <span className="text-xs text-default-400">
                {token.operatorIds.length} 个操作员
              </span>
            )}
            {token.maxOperators !== undefined && token.role !== 'admin' && (
              <span className="text-xs text-default-400">
                上限 {token.maxOperators === 0 ? '无限制' : token.maxOperators}
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
                title="重新生成令牌"
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
                title="撤销令牌"
              >
                <FontAwesomeIcon icon={faTrash} />
              </Button>
            )}
          </div>
        </div>
        <div className="text-xs text-default-400 flex gap-3">
          <span>创建于 {new Date(token.createdAt).toLocaleDateString()}</span>
          {token.lastUsedAt && (
            <span>最近使用 {new Date(token.lastUsedAt).toLocaleDateString()}</span>
          )}
          {token.expiresAt && (
            <span>过期: {new Date(token.expiresAt).toLocaleDateString()}</span>
          )}
          {token.revoked && <span className="text-danger">已撤销</span>}
        </div>
        {token.operatorIds.length > 0 && (
          <div className="text-xs text-default-500">
            操作员: {token.operatorIds.map((id) => {
              const op = operators.find((o) => o.id === id);
              return op ? `${op.context.myCall}(${op.context.txFrequency}Hz)` : id;
            }).join(', ')}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function TokenManagement() {
  const { operators } = useOperators();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreateTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);
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
      console.error('加载 Token 列表失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

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
        title: '创建失败',
        description: err instanceof Error ? err.message : '未知错误',
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
      addToast({ title: '令牌已撤销', color: 'success', timeout: 3000 });
      await loadTokens();
    } catch (err) {
      addToast({
        title: '撤销失败',
        description: err instanceof Error ? err.message : '未知错误',
        color: 'danger',
        timeout: 5000,
      });
    }
  }, [loadTokens]);

  // 重新生成系统令牌
  const handleRegenerate = useCallback(async (tokenId: string) => {
    try {
      const resp = await api.regenerateToken(tokenId);
      setCreatedToken(resp);
      addToast({ title: '令牌已重新生成', color: 'success', timeout: 3000 });
      await loadTokens();
    } catch (err) {
      addToast({
        title: '重新生成失败',
        description: err instanceof Error ? err.message : '未知错误',
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
      addToast({ title: '复制失败', color: 'danger', timeout: 2000 });
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
        <h3 className="text-lg font-semibold">访问令牌管理</h3>
        <Button
          size="sm"
          color="primary"
          startContent={<FontAwesomeIcon icon={faPlus} />}
          onPress={() => setCreateModalOpen(true)}
        >
          创建新令牌
        </Button>
      </div>

      {/* Token 列表 */}
      {(() => {
        const activeTokens = tokens.filter(t => !t.revoked);
        const revokedTokens = tokens.filter(t => t.revoked);

        return (
          <div className="space-y-2">
            {tokens.length === 0 && (
              <p className="text-default-400 text-sm text-center py-8">暂无令牌</p>
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
                  <span>已撤销的令牌 ({revokedTokens.length})</span>
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
          <ModalHeader>创建访问令牌</ModalHeader>
          <ModalBody className="gap-4">
            <Input
              label="标签名称"
              placeholder="例如：张三的操作权限"
              value={newLabel}
              onValueChange={setNewLabel}
              isRequired
            />
            <RadioGroup
              label="角色"
              value={newRole}
              onValueChange={(v) => setNewRole(v as UserRole)}
            >
              <Radio value={UserRole.VIEWER} description="只能查看，不能操作">查看者</Radio>
              <Radio value={UserRole.OPERATOR} description="可操作被授权的操作员">操作员</Radio>
              <Radio value={UserRole.ADMIN} description="完全控制权限">管理员</Radio>
            </RadioGroup>

            {newRole !== UserRole.ADMIN && operators.length > 0 && (
              <CheckboxGroup
                label="授权操作员"
                value={newOperatorIds}
                onValueChange={setNewOperatorIds}
              >
                {operators.map((op) => (
                  <Checkbox key={op.id} value={op.id}>
                    {op.context.myCall} ({op.context.txFrequency} Hz)
                  </Checkbox>
                ))}
              </CheckboxGroup>
            )}

            <Select
              label="有效期"
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
                label="操作员上限"
                description="该令牌可拥有的操作员总数（0 表示不限制）"
                value={newMaxOperators}
                onValueChange={setNewMaxOperators}
                min={0}
              />
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setCreateModalOpen(false)}>取消</Button>
            <Button
              color="primary"
              onPress={handleCreate}
              isLoading={creating}
              isDisabled={!newLabel.trim()}
            >
              创建令牌
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 创建成功弹窗 */}
      <Modal isOpen={!!createdToken} onClose={() => setCreatedToken(null)} size="md">
        <ModalContent>
          <ModalHeader>令牌已生成</ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm text-default-600">
              请妥善保管以下令牌，此令牌仅显示一次，之后无法再次查看：
            </p>
            <div className="flex items-center gap-2 bg-default-100 rounded-lg p-3">
              <code className="flex-1 text-sm break-all">{createdToken?.token}</code>
              <Button
                size="sm"
                variant="flat"
                isIconOnly
                onPress={() => handleCopy(createdToken?.token || '')}
                title="复制令牌"
              >
                <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
              </Button>
            </div>
            <div className="text-xs text-default-400">
              <p>标签: {createdToken?.label}</p>
              <p>角色: {ROLE_LABELS[createdToken?.role || '']}</p>
              {createdToken?.operatorIds && createdToken.operatorIds.length > 0 && (
                <p>操作员: {createdToken.operatorIds.join(', ')}</p>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button color="primary" onPress={() => setCreatedToken(null)}>完成</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
