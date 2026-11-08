import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardBody, Chip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import type { PluginLoadFailure } from '@tx5dr/contracts';
import { resolvePluginName } from '../../utils/pluginLocales';

interface PluginLoadFailureListProps {
  failures: PluginLoadFailure[];
  pluginApiVersion?: string;
}

/** i18n key and default text explaining why a plugin did not load and what to do. */
export function describePluginLoadFailure(failure: PluginLoadFailure): { key: string; defaultValue: string } {
  switch (failure.reason) {
    case 'plugin-api-requires-newer-host':
      return {
        key: 'plugins.loadFailureRequiresNewerHost',
        defaultValue: 'Requires Plugin API ^{{required}}. Update TX-5DR to use this plugin.',
      };
    case 'plugin-api-unsupported':
      return {
        key: 'plugins.loadFailureUnsupported',
        defaultValue: 'Built for Plugin API ^{{required}}, which this TX-5DR no longer loads. Install an updated version from the marketplace or ask the plugin author for an update.',
      };
    default:
      return {
        key: 'plugins.loadFailureInvalid',
        defaultValue: 'The plugin files are incomplete or invalid. Reinstall it or check the plugin runtime log.',
      };
  }
}

/**
 * Plugin directories that the Host found but did not load. Without this list a
 * rejected plugin would silently disappear from the Installed view.
 */
export const PluginLoadFailureList: React.FC<PluginLoadFailureListProps> = ({ failures, pluginApiVersion }) => {
  const { t } = useTranslation('settings');
  if (failures.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wider text-default-400">
        {t('plugins.loadFailuresTitle', 'Plugins that did not load')}
      </div>
      {failures.map((failure) => {
        const description = describePluginLoadFailure(failure);
        const name = failure.pluginName ?? failure.directoryName;
        return (
          <Card key={failure.directoryName} className="w-full border border-warning-200 bg-warning-50/40" shadow="none">
            <CardBody className="gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <FontAwesomeIcon icon={faTriangleExclamation} className="text-xs text-warning" />
                <span className="text-sm font-medium">{resolvePluginName(name, name)}</span>
                {failure.version && <span className="text-xs text-default-400">v{failure.version}</span>}
                <Chip as="span" size="sm" variant="flat" color="warning" className="h-4 text-xs">
                  {t('plugins.loadFailureChip', 'Not loaded')}
                </Chip>
                {failure.source?.kind === 'marketplace' && (
                  <Chip as="span" size="sm" variant="flat" className="h-4 text-xs">
                    {t('plugins.marketManagedByMarketplace', 'Managed by marketplace')}
                  </Chip>
                )}
              </div>
              <div className="text-xs text-default-600">
                {t(description.key, {
                  defaultValue: description.defaultValue,
                  required: failure.minPluginApiVersion ?? '',
                })}
                {pluginApiVersion && failure.reason !== 'invalid-plugin' && (
                  <>
                    {' '}
                    {t('plugins.loadFailureCurrentApi', 'This TX-5DR bundles Plugin API {{version}}.', {
                      version: pluginApiVersion,
                    })}
                  </>
                )}
              </div>
              {failure.message && (
                <div className="truncate text-[11px] text-default-400" title={failure.message}>
                  {failure.message}
                </div>
              )}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
};
