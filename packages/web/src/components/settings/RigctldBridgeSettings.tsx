import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Select,
  SelectItem,
  Switch,
} from '@heroui/react';
import { api, ApiError } from '@tx5dr/core';
import type { RigctldBridgeConfig, RigctldStatus } from '@tx5dr/contracts';
import { useCan } from '../../store/authStore';
import { useConnection } from '../../store/radioStore';
import { useWSEvent } from '../../hooks/useWSEvent';
import { showErrorToast } from '../../utils/errorToast';
import { createLogger } from '../../utils/logger';

const logger = createLogger('RigctldBridgeSettings');

/**
 * Imperative API exposed to `SettingsModal`. Follows the same contract as the
 * other `*SettingsRef` types in this directory so the modal's shared footer
 * ("Save settings" button + dirty indicator + close-confirmation dialog) can
 * drive the save flow uniformly.
 */
export interface RigctldBridgeSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface RigctldBridgeSettingsProps {
  /** Fires whenever the dirty flag changes, so the modal can enable its Save button. */
  onUnsavedChanges?: (dirty: boolean) => void;
}

interface FormState {
  enabled: boolean;
  bindAddress: string;
  /**
   * User intent for the bind-address dropdown. Tracked explicitly (rather
   * than derived from `bindAddress`) so a custom value that happens to equal
   * a preset doesn't suddenly collapse the input field, and so switching to
   * "custom" clears the preset instead of leaving it pre-filled.
   */
  bindMode: 'all' | 'loopback' | 'custom';
  port: number;
  readOnly: boolean;
}

const BIND_PRESETS = ['0.0.0.0', '127.0.0.1'] as const;
type BindPreset = (typeof BIND_PRESETS)[number];

function isBindPreset(addr: string): addr is BindPreset {
  return (BIND_PRESETS as readonly string[]).includes(addr);
}

function toForm(config: RigctldBridgeConfig | undefined): FormState {
  const addr = config?.bindAddress ?? '0.0.0.0';
  return {
    enabled: config?.enabled ?? false,
    bindAddress: addr,
    bindMode: addr === '0.0.0.0' ? 'all' : addr === '127.0.0.1' ? 'loopback' : 'custom',
    port: config?.port ?? 4532,
    readOnly: config?.readOnly ?? true,
  };
}

function formatDuration(
  ms: number,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t('rigctld.durationSeconds', { count: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('rigctld.durationMinutes', { count: min });
  const hr = Math.floor(min / 60);
  return t('rigctld.durationHours', { count: hr });
}

export const RigctldBridgeSettings = forwardRef<
  RigctldBridgeSettingsRef,
  RigctldBridgeSettingsProps
>(({ onUnsavedChanges }, ref) => {
  const { t } = useTranslation('settings');
  const canEdit = useCan('execute', 'RigctldBridge');
  const connection = useConnection();
  const [status, setStatus] = useState<RigctldStatus | null>(null);
  const [form, setForm] = useState<FormState>({
    enabled: false,
    bindAddress: '0.0.0.0',
    bindMode: 'all',
    port: 4532,
    readOnly: true,
  });
  const [loading, setLoading] = useState(true);

  // Keep a live ref to the latest form so the imperative `save()` can read the
  // current values without needing to be rebuilt on every render.
  const formRef = useRef(form);
  formRef.current = form;

  const refresh = useCallback(async () => {
    try {
      const data = await api.getRigctldStatus();
      setStatus(data);
      setForm(toForm(data.config));
    } catch (error) {
      logger.warn('failed to fetch rigctld status', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates: server broadcasts rigctldStatus whenever clients connect /
  // disconnect or the listener is reconciled.
  useWSEvent(
    connection.state.radioService,
    'rigctldStatus',
    (incoming: RigctldStatus) => {
      setStatus((prev) => {
        // Only rehydrate form fields when the form currently matches the
        // previous server state — otherwise the user has uncommitted edits we
        // must not clobber.
        const prevConfig = prev?.config;
        const f = formRef.current;
        const inSync =
          !prevConfig ||
          (f.enabled === prevConfig.enabled &&
            f.bindAddress === prevConfig.bindAddress &&
            f.port === prevConfig.port &&
            f.readOnly === (prevConfig.readOnly ?? true));
        if (inSync) {
          setForm(toForm(incoming.config));
        }
        return incoming;
      });
    },
  );

  const hasUnsavedChanges = useCallback(() => {
    const cur = status?.config;
    if (!cur) return false;
    return (
      form.enabled !== cur.enabled ||
      form.bindAddress !== cur.bindAddress ||
      form.port !== cur.port ||
      form.readOnly !== (cur.readOnly ?? true)
    );
  }, [form, status]);

  const dirty = useMemo(() => hasUnsavedChanges(), [hasUnsavedChanges]);

  useEffect(() => {
    onUnsavedChanges?.(dirty);
  }, [dirty, onUnsavedChanges]);

  const save = useCallback(async () => {
    if (!canEdit) return;
    const f = formRef.current;
    try {
      const result = await api.updateRigctldConfig({
        enabled: f.enabled,
        bindAddress: f.bindAddress,
        port: f.port,
        readOnly: f.readOnly,
      });
      setStatus(result);
      setForm(toForm(result.config));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error);
      showErrorToast({
        userMessage: t('rigctld.saveFailed', { message }),
      });
      logger.error('rigctld config save failed', error);
      // Re-throw so SettingsModal's handleConfirmSave can skip the post-save
      // transition (close / tab change) when persistence fails.
      throw error;
    }
  }, [canEdit, t]);

  useImperativeHandle(
    ref,
    () => ({
      hasUnsavedChanges,
      save,
    }),
    [hasUnsavedChanges, save],
  );

  const bindWarning = form.bindAddress === '0.0.0.0';
  const clients = status?.clients ?? [];
  const running = status?.running ?? false;
  const address = status?.address;

  return (
    <Card classNames={{ base: 'border border-divider bg-content1' }}>
      <CardBody className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-default-900">{t('rigctld.title')}</h3>
            <p className="text-sm leading-6 text-default-600">{t('rigctld.description')}</p>
          </div>
          <Chip size="sm" color={running ? 'success' : 'default'} variant="flat">
            {running ? t('rigctld.statusRunning') : t('rigctld.statusStopped')}
          </Chip>
        </div>

        <Switch
          isSelected={form.enabled}
          isDisabled={!canEdit || loading}
          onValueChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
        >
          {t('rigctld.enableLabel')}
        </Switch>

        <div className="grid gap-3 md:grid-cols-2">
          <Select
            label={t('rigctld.bindAddressLabel')}
            selectedKeys={new Set([form.bindMode])}
            onChange={(e) => {
              const value = e.target.value as FormState['bindMode'] | '';
              if (!value) return;
              setForm((f) => {
                if (value === 'all') return { ...f, bindMode: 'all', bindAddress: '0.0.0.0' };
                if (value === 'loopback')
                  return { ...f, bindMode: 'loopback', bindAddress: '127.0.0.1' };
                return {
                  ...f,
                  bindMode: 'custom',
                  bindAddress: isBindPreset(f.bindAddress) ? '' : f.bindAddress,
                };
              });
            }}
            isDisabled={!canEdit || loading}
          >
            <SelectItem key="all">{t('rigctld.bindAllInterfaces')}</SelectItem>
            <SelectItem key="loopback">{t('rigctld.bindLoopback')}</SelectItem>
            <SelectItem key="custom">{t('rigctld.bindCustom')}</SelectItem>
          </Select>

          {form.bindMode === 'custom' && (
            <Input
              label={t('rigctld.bindAddressCustom')}
              placeholder={t('rigctld.bindAddressCustomPlaceholder')}
              value={form.bindAddress}
              onValueChange={(v) => setForm((f) => ({ ...f, bindAddress: v }))}
              isDisabled={!canEdit || loading}
            />
          )}

          <Input
            type="number"
            label={t('rigctld.portLabel')}
            min={1}
            max={65535}
            value={String(form.port)}
            onValueChange={(v) => {
              const n = Number(v);
              if (Number.isFinite(n)) setForm((f) => ({ ...f, port: n }));
            }}
            isDisabled={!canEdit || loading}
          />
        </div>

        {bindWarning && form.enabled && (
          <Alert color="warning" title={t('rigctld.lanExposureTitle')}>
            {t('rigctld.lanExposureBody')}
          </Alert>
        )}

        <div className="rounded-medium border border-divider bg-default-50 px-3 py-3 dark:bg-default-100/5">
          <Switch
            isSelected={form.readOnly}
            isDisabled={!canEdit || loading}
            onValueChange={(v) => setForm((f) => ({ ...f, readOnly: v }))}
          >
            {t('rigctld.readOnlyLabel')}
          </Switch>
          <p className="mt-2 text-xs leading-5 text-default-500">
            {form.readOnly ? t('rigctld.readOnlyOnHint') : t('rigctld.readOnlyOffHint')}
          </p>
          {!form.readOnly && form.enabled && (
            <Alert
              color="danger"
              className="mt-3"
              title={t('rigctld.readOnlyOffDangerTitle')}
            >
              {t('rigctld.readOnlyOffDangerBody')}
            </Alert>
          )}
        </div>

        {status?.error && (
          <Alert color="danger" title={t('rigctld.listenerErrorTitle')}>
            {status.error}
          </Alert>
        )}

        <div className="rounded-medium bg-default-50 px-3 py-3 dark:bg-default-100/5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-default-900">{t('rigctld.clientsTitle')}</p>
            <Button size="sm" variant="flat" onPress={() => { void refresh(); }} isDisabled={loading}>
              {t('rigctld.refreshButton')}
            </Button>
          </div>
          {running ? (
            <p className="text-xs leading-5 text-default-500">
              {address ? t('rigctld.listeningOn', { host: address.host, port: address.port }) : ''}
            </p>
          ) : (
            <p className="text-xs leading-5 text-default-500">{t('rigctld.notListening')}</p>
          )}
          {clients.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-default-400">{t('rigctld.noClients')}</p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs">
              {clients.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-default-700">{c.peer}</span>
                  <Chip size="sm" variant="flat">
                    {formatDuration(Date.now() - c.connectedAt, t)}
                  </Chip>
                  {c.lastCommand && (
                    <span className="text-default-500">
                      {t('rigctld.lastCommand', { command: c.lastCommand })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-medium bg-default-50 px-3 py-3 dark:bg-default-100/5">
          <p className="text-sm font-medium text-default-900">{t('rigctld.clientSetupTitle')}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-default-600">
            <li>{t('rigctld.clientSetupN1MM')}</li>
            <li>{t('rigctld.clientSetupWsjtx')}</li>
            <li>{t('rigctld.clientSetupDocker')}</li>
          </ul>
        </div>

        {!canEdit && (
          <p className="text-xs text-default-500">{t('rigctld.insufficientPermission')}</p>
        )}
      </CardBody>
    </Card>
  );
});

RigctldBridgeSettings.displayName = 'RigctldBridgeSettings';
