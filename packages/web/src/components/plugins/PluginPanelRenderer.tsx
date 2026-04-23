import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardBody, CardHeader } from '@heroui/react';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { useConnection } from '../../store/radioStore';
import { useWSEvent } from '../../hooks/useWSEvent';
import { usePluginPanelMeta } from '../../hooks/usePluginPanelMeta';
import { resolvePluginLabelWithValues } from '../../utils/pluginLocales';
import { PluginIframeHost } from './PluginIframeHost';

interface PluginPanelRendererProps {
  pluginName: string;
  operatorId: string;
  panelId: string;
  title: string;
  component: 'table' | 'key-value' | 'chart' | 'log' | 'iframe';
  pageId?: string;
  /** 'card' wraps in a Card (operator panel), 'inline' renders bare (automation popover). */
  variant?: 'card' | 'inline';
}

export const PluginPanelRenderer: React.FC<PluginPanelRendererProps> = ({
  pluginName,
  operatorId,
  panelId,
  title: staticTitle,
  component,
  pageId,
  variant = 'card',
}) => {
  const { t } = useTranslation('settings');
  const connection = useConnection();
  const getMeta = usePluginPanelMeta();
  const [data, setData] = React.useState<unknown>(null);

  const meta = getMeta(pluginName, operatorId, panelId);

  if (meta.visible === false) {
    return null;
  }

  const effectiveTitle = meta.title !== undefined && meta.title !== null
    ? resolvePluginLabelWithValues(meta.title, pluginName, meta.titleValues)
    : staticTitle;
  const hasTitle = effectiveTitle.trim().length > 0;

  useWSEvent(connection.state.radioService, 'pluginData', (payload: Parameters<DigitalRadioEngineEvents['pluginData']>[0]) => {
    if (
      payload.pluginName === pluginName
      && payload.operatorId === operatorId
      && payload.panelId === panelId
    ) {
      setData(payload.data);
    }
  });

  // --- iframe panel ---
  if (component === 'iframe' && pageId) {
    if (variant === 'inline') {
      return (
        <div className="rounded-md border border-default-200/70 bg-content1 overflow-hidden">
          {hasTitle && (
            <div className="px-2.5 pt-2 pb-0 text-[11px] text-default-500">
              {effectiveTitle}
            </div>
          )}
          <PluginIframeHost
            pluginName={pluginName}
            pageId={pageId}
            params={{ operatorId }}
            minHeight={64}
          />
        </div>
      );
    }
    return (
      <Card>
        {hasTitle && (
          <CardHeader className="pb-0 pt-2 px-3">
            <span className="text-xs font-medium text-default-600">{effectiveTitle}</span>
          </CardHeader>
        )}
        <CardBody className="p-0 overflow-hidden">
          <PluginIframeHost
            pluginName={pluginName}
            pageId={pageId}
            params={{ operatorId }}
            minHeight={0}
          />
        </CardBody>
      </Card>
    );
  }

  // --- structured panel: inline variant ---
  if (variant === 'inline') {
    return (
      <div className="rounded-md border border-default-200/70 bg-content1 px-2.5 py-2">
        {hasTitle && (
          <div className="mb-1 text-[11px] text-default-500">
            {effectiveTitle}
          </div>
        )}
        {data === null ? (
          <div className="text-xs text-default-400 text-center py-1">
            {t('plugins.noData', 'No data yet')}
          </div>
        ) : (
          <PanelContent component={component} data={data} />
        )}
      </div>
    );
  }

  // --- structured panel: card variant (default) ---
  return (
    <Card>
      {hasTitle && (
        <CardHeader className="pb-0 pt-2 px-3">
          <span className="text-xs font-medium text-default-600">{effectiveTitle}</span>
        </CardHeader>
      )}
      <CardBody className="pt-2">
        {data === null ? (
          <div className="text-xs text-default-400 text-center py-2">
            {t('plugins.noData', 'No data yet')}
          </div>
        ) : (
          <PanelContent component={component} data={data} />
        )}
      </CardBody>
    </Card>
  );
};

interface PanelContentProps {
  component: string;
  data: unknown;
}

export const PanelContent: React.FC<PanelContentProps> = ({ component, data }) => {
  if (component === 'key-value' && typeof data === 'object' && data !== null) {
    return (
      <div className="flex flex-col gap-1">
        {Object.entries(data as Record<string, unknown>).map(([key, value]) => (
          <div key={key} className="flex justify-between text-xs gap-3">
            <span className="text-default-400">{key}</span>
            <span className="font-medium text-right">{String(value)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (component === 'log' && Array.isArray(data)) {
    return (
      <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
        {(data as string[]).map((entry, i) => (
          <div key={i} className="text-xs text-default-500 font-mono">{entry}</div>
        ))}
      </div>
    );
  }

  if (component === 'table' && Array.isArray(data) && data.length > 0) {
    const columns = Object.keys(data[0] as Record<string, unknown>);
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col} className="text-left text-default-400 pb-1 pr-2">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data as Record<string, unknown>[]).map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col} className="pr-2 py-0.5">{String(row[col] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <pre className="text-xs text-default-400 whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
};
