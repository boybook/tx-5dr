import { useMemo } from 'react';
import { Accordion, AccordionItem, Alert, Button, Card, CardBody, Chip, Input, Switch } from '@heroui/react';
import type { NetworkInfo, RemoteAccessPreset, RemoteAccessSecurityStatus } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import {
  applyRemoteAccessPreset,
  normalizeRemoteAccessOrigin,
  REMOTE_ACCESS_PRESET_LIMITS,
} from './remoteAccessDraft';

const PRESETS: RemoteAccessPreset[] = ['local', 'lan', 'public'];

interface RemoteAccessSettingsCardProps {
  settings: RemoteAccessSecurityStatus | null;
  network: NetworkInfo | null;
  isSaving: boolean;
  onChange: (settings: RemoteAccessSecurityStatus) => void;
}

export function RemoteAccessSettingsCard({
  settings,
  network,
  isSaving,
  onChange,
}: RemoteAccessSettingsCardProps) {
  const { t } = useTranslation();
  const custom = useMemo(() => {
    if (!settings) return false;
    const defaults = Object.values(REMOTE_ACCESS_PRESET_LIMITS[settings.preset]);
    return [settings.maxConnections, settings.maxConnectionsPerIp, settings.maxPendingAuth]
      .some((value, index) => value !== defaults[index]);
  }, [settings]);
  const supportedPresets = network
    ? (network.supportedPresets?.length ? network.supportedPresets : PRESETS.filter(preset => network.supportsLocalOnly || preset !== 'local'))
    : PRESETS.filter(preset => preset !== 'local');
  const supportsLocalOnly = network?.supportsLocalOnly ?? false;
  const currentBrowserOrigin = typeof window === 'undefined' || ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
    ? null
    : window.location.origin;

  const updateOrigin = (index: number, value: string) => {
    if (!settings) return;
    const allowedOrigins = [...settings.allowedOrigins];
    allowedOrigins[index] = value;
    onChange({ ...settings, allowedOrigins });
  };

  const removeOrigin = (index: number) => {
    if (!settings) return;
    onChange({
      ...settings,
      allowedOrigins: settings.allowedOrigins.filter((_, candidateIndex) => candidateIndex !== index),
    });
  };

  const addOrigin = (value = '') => {
    if (!settings) return;
    if (value && settings.allowedOrigins.includes(value)) return;
    onChange({ ...settings, allowedOrigins: [...settings.allowedOrigins, value] });
  };

  const selectPreset = (preset: RemoteAccessPreset) => {
    if (!settings) return;
    onChange(applyRemoteAccessPreset(settings, preset));
  };

  if (!settings) return null;

  return (
    <Card shadow="none" radius="lg" className="order-1 border border-divider bg-content1">
      <CardBody className="p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-base font-semibold text-default-900">{t('system.remoteAccessTitle')}</h4>
              {custom && <Chip size="sm" variant="flat">{t('system.remoteAccessCustomized')}</Chip>}
            </div>
            <p className="mt-1 text-sm leading-6 text-default-600">{t('system.remoteAccessDesc')}</p>
          </div>
          <Chip color={settings.preset === 'local' ? 'default' : settings.preset === 'lan' ? 'primary' : 'warning'} variant="flat">
            {settings.activeConnections}/{settings.maxConnections}
          </Chip>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {supportedPresets.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={isSaving}
              onClick={() => selectPreset(preset)}
              className={`rounded-xl border p-4 text-left transition ${settings.preset === preset ? 'border-primary bg-primary-50 dark:bg-primary-500/10' : 'border-divider bg-default-50 hover:border-default-400'}`}
            >
              <p className="font-medium text-default-900">{t(`system.remoteAccessPreset.${preset}.title`)}</p>
              <p className="mt-1 text-xs leading-5 text-default-500">{t(`system.remoteAccessPreset.${preset}.desc`)}</p>
            </button>
          ))}
        </div>

        {network?.runtimeManagement === 'external' && (
          <Alert color="default" variant="flat" className="text-xs">
            {t(supportsLocalOnly ? 'system.remoteAccessExternalManaged' : 'system.remoteAccessServerManaged')}
          </Alert>
        )}

        {settings.preset !== 'local' && (
          <div className="rounded-xl border border-divider p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-default-900">{t('system.remoteAccessPublicViewer')}</p>
                <p className="text-xs text-default-500">{t('system.remoteAccessLoginRequired')}</p>
              </div>
              <Switch
                size="sm"
                isSelected={settings.allowPublicViewing}
                isDisabled={isSaving}
                onValueChange={(enabled) => onChange({ ...settings, allowPublicViewing: enabled })}
              />
            </div>
          </div>
        )}

        {settings.preset === 'public' && (
          <div className="space-y-4 rounded-xl border border-warning-300 bg-warning-50/50 p-4 dark:bg-warning-500/5">
            <Alert color="warning" variant="flat" className="text-sm">
              <div className="space-y-1">
                <p className="font-medium">{t('system.remoteAccessPublicSafetyTitle')}</p>
                <p>{t('system.remoteAccessPublicSafetyDesc')}</p>
              </div>
            </Alert>

            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h5 className="text-sm font-semibold text-default-900">{t('system.remoteAccessAllowedWebAddresses')}</h5>
                <Chip size="sm" color="warning" variant="flat">{t('system.remoteAccessRequired')}</Chip>
              </div>
              <p className="mt-1 text-xs leading-5 text-default-600">{t('system.remoteAccessAllowedWebAddressesDesc')}</p>
              {settings.allowedOrigins.length === 0 && (
                <p className="mt-2 text-xs font-medium text-warning-700 dark:text-warning-400">
                  {t('system.remoteAccessOriginRequired')}
                </p>
              )}
            </div>

            <div className="space-y-3">
              {settings.allowedOrigins.map((origin, index) => {
                const invalid = origin.length > 0 && !normalizeRemoteAccessOrigin(origin);
                return (
                  <div key={index} className="flex items-start gap-2">
                    <Input
                      className="flex-1"
                      label={t('system.remoteAccessWebAddress', { index: index + 1 })}
                      placeholder="http://radio.example.com:8076"
                      value={origin}
                      isInvalid={invalid}
                      errorMessage={invalid ? t('system.remoteAccessOriginInvalid') : undefined}
                      onValueChange={value => updateOrigin(index, value)}
                    />
                    <Button className="mt-2" size="sm" variant="light" color="danger" onPress={() => removeOrigin(index)}>
                      {t('button.delete')}
                    </Button>
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="flat" onPress={() => addOrigin()}>{t('system.remoteAccessAddWebAddress')}</Button>
                {currentBrowserOrigin && !settings.allowedOrigins.includes(currentBrowserOrigin) && (
                  <Button size="sm" variant="light" onPress={() => addOrigin(currentBrowserOrigin)}>
                    {t('system.remoteAccessUseCurrentAddress', { origin: currentBrowserOrigin })}
                  </Button>
                )}
              </div>
            </div>

            <Accordion variant="light">
              <AccordionItem key="public-help" title={t('system.remoteAccessMethodHelpTitle')}>
                <div className="space-y-3 pb-3 text-xs leading-5 text-default-600">
                  <p><strong className="text-default-900">{t('system.remoteAccessPrivateNetworkTitle')}</strong> {t('system.remoteAccessPrivateNetworkDesc')}</p>
                  <p><strong className="text-default-900">{t('system.remoteAccessProxyTitle')}</strong> {t('system.remoteAccessProxyDesc')}</p>
                  <p><strong className="text-danger-600">{t('system.remoteAccessDirectPublicTitle')}</strong> {t('system.remoteAccessDirectPublicDesc')}</p>
                  <p className="text-default-500">{t('system.remoteAccessOriginTerm')}</p>
                </div>
              </AccordionItem>
            </Accordion>

            <p className="text-xs leading-5 text-default-500">{t('system.remoteAccessSecurityOngoing')}</p>
          </div>
        )}

        {network?.addresses?.length ? (
          <div className="flex flex-wrap gap-2">
            {network.addresses.map(address => <code key={address.ip} className="rounded bg-default-100 px-2 py-1 text-xs">{address.url}</code>)}
          </div>
        ) : null}

        <Accordion variant="light" selectionMode="multiple">
          <AccordionItem key="advanced" title={t('system.remoteAccessAdvanced')} subtitle={t('system.remoteAccessAdvancedDesc')}>
            <div className="grid grid-cols-1 gap-3 pb-4 md:grid-cols-2 xl:grid-cols-3">
              <Input type="number" label={t('system.remoteAccessMaxUsers')} value={String(settings.maxConnections)} onValueChange={value => onChange({ ...settings, maxConnections: Number(value) })} />
              <Input type="number" label={t('system.remoteAccessPerIp')} value={String(settings.maxConnectionsPerIp)} onValueChange={value => onChange({ ...settings, maxConnectionsPerIp: Number(value) })} />
              <Input type="number" label={t('system.remoteAccessPendingAuth')} value={String(settings.maxPendingAuth)} onValueChange={value => onChange({ ...settings, maxPendingAuth: Number(value) })} />
              <Input type="number" label={t('system.remoteAccessAuthTimeout')} value={String(settings.authTimeoutMs / 1000)} onValueChange={value => onChange({ ...settings, authTimeoutMs: Number(value) * 1000 })} />
              <Input type="number" label={t('system.remoteAccessHandshakeTimeout')} value={String(settings.handshakeTimeoutMs / 1000)} onValueChange={value => onChange({ ...settings, handshakeTimeoutMs: Number(value) * 1000 })} />
            </div>
            {settings.preset !== 'public' && (
              <Input
                label={t('system.remoteAccessOrigins')}
                description={t('system.remoteAccessOriginsDesc')}
                value={settings.allowedOrigins.join(', ')}
                onValueChange={value => onChange({ ...settings, allowedOrigins: value.split(',').map(item => item.trim()).filter(Boolean) })}
              />
            )}
          </AccordionItem>
        </Accordion>
      </CardBody>
    </Card>
  );
}
