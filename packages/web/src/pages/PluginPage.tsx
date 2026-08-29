import * as React from 'react';
import { Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { api, configureAuthToken } from '@tx5dr/core';
import type { PluginStatus, PluginUIPageDescriptor } from '@tx5dr/contracts';
import { AuthProvider, useAuth } from '../store/authStore';
import { LoginPage } from './LoginPage';
import { PluginIframeHost } from '../components/plugins/PluginIframeHost';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { useLanguage } from '../hooks/useLanguage';
import { useTheme } from '../hooks/useTheme';
import { useViewportHeightCssVar } from '../hooks/useViewportHeight';
import { pluginApi } from '../utils/pluginApi';
import { isElectron, isMacOS } from '../utils/config';
import { createLogger } from '../utils/logger';
import { registerPluginLocales, resolvePluginLabel, resolvePluginName } from '../utils/pluginLocales';
import { resolvePluginPageParameters } from './pluginPageParameters';

const logger = createLogger('PluginPage');

interface ResolvedPluginPage {
  plugin: PluginStatus;
  page: PluginUIPageDescriptor;
}

const PluginPageContent: React.FC = () => {
  const { t } = useTranslation('common');
  const parameters = React.useMemo(
    () => resolvePluginPageParameters(window.location.search),
    [],
  );
  const [resolved, setResolved] = React.useState<ResolvedPluginPage | null>(null);
  const [operatorLabel, setOperatorLabel] = React.useState('');
  const [error, setError] = React.useState('');
  const inElectron = isElectron();
  const electronHeaderClass = inElectron
    ? isMacOS() ? 'pl-20' : 'pr-36'
    : '';

  React.useEffect(() => {
    configureAuthToken(localStorage.getItem('tx5dr_jwt'));
    if (!parameters.valid) {
      setError(t('pluginPage.invalidRoute'));
      return;
    }

    let active = true;
    pluginApi.getPlugins()
      .then((snapshot) => {
        if (!active) return;
        const plugin = snapshot.plugins.find((candidate) => candidate.name === parameters.pluginName);
        const page = plugin?.ui?.pages?.find((candidate) => candidate.id === parameters.pageId);
        if (!plugin || !page || plugin.loaded === false || !plugin.enabled) {
          setError(t('pluginPage.unavailable'));
          return;
        }
        if ((plugin.instanceScope ?? 'operator') === 'operator' && !parameters.operatorId) {
          setError(t('pluginPage.operatorRequired'));
          return;
        }
        registerPluginLocales(plugin.name, plugin.locales);
        setResolved({ plugin, page });
        if (parameters.operatorId) {
          void api.getOperator(parameters.operatorId)
            .then((response) => {
              if (active) setOperatorLabel(response.data?.myCallsign || parameters.operatorId || '');
            })
            .catch(() => {
              if (active) setOperatorLabel(parameters.operatorId || '');
            });
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        logger.error('Failed to resolve standalone plugin page', reason);
        setError(reason instanceof Error ? reason.message : t('pluginPage.loadFailed'));
      });

    return () => {
      active = false;
    };
  }, [parameters, t]);

  const title = resolved
    ? resolvePluginLabel(resolved.page.title, resolved.plugin.name)
      || resolvePluginName(resolved.plugin.name, resolved.plugin.name)
    : t('pluginPage.title');
  const contextualTitle = operatorLabel ? `${title} - ${operatorLabel}` : title;

  React.useEffect(() => {
    document.title = `${contextualTitle} - TX-5DR`;
  }, [contextualTitle]);

  if (error) {
    return (
      <div role="alert" className="flex flex-1 items-center justify-center p-6 text-center text-danger">
        {error}
      </div>
    );
  }

  if (!resolved) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <>
      <header
        className={`flex h-12 shrink-0 items-center justify-between border-b border-divider bg-content1 px-4 ${electronHeaderClass}`}
        style={inElectron ? { WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string } : undefined}
      >
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-foreground">{contextualTitle}</h1>
          <p className="truncate text-xs text-default-400">
            {resolvePluginName(resolved.plugin.name, resolved.plugin.name)}
          </p>
        </div>
        <div style={inElectron ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string } : undefined}>
          <ThemeToggle variant="button" size="sm" />
        </div>
      </header>
      <PluginIframeHost
        key={`${resolved.plugin.name}:${resolved.page.id}`}
        pluginName={resolved.plugin.name}
        pageId={resolved.page.id}
        params={parameters.params}
        fillHeight
        className="min-h-0 flex-1"
      />
    </>
  );
};

const PluginPageAuthGate: React.FC = () => {
  const { state } = useAuth();
  if (!state.initialized || !state.sessionResolved) return null;
  if (state.authEnabled && !state.jwt) return <LoginPage />;
  return <PluginPageContent />;
};

export const PluginPage: React.FC = () => {
  useLanguage();
  useTheme();
  useViewportHeightCssVar();

  return (
    <div className="app-viewport-height flex min-h-0 flex-col overflow-hidden bg-background">
      <AuthProvider>
        <PluginPageAuthGate />
      </AuthProvider>
    </div>
  );
};
