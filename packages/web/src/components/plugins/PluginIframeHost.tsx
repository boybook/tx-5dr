import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@heroui/react';
import { ConnectionContext } from '../../store/radio/contexts';
import { useWSEvent } from '../../hooks/useWSEvent';
import { createLogger } from '../../utils/logger';
import { getAuthHeaders, getStoredJwt } from '../../utils/authHeaders';

const logger = createLogger('PluginIframeHost');

/**
 * Generic iframe host for plugin custom UI pages.
 *
 * Renders a plugin's declared UI page inside a sandboxed iframe. Handles the
 * postMessage bridge protocol for store/file operations, custom invoke/push
 * messaging, CSS token injection, theme syncing and height auto-resize.
 *
 * This component is business-agnostic — it does not know what the iframe
 * renders. Consumers pass `params` to provide context (e.g. a logbook sync
 * host passes `{ callsign: 'W5ABC' }`).
 */

interface PluginIframeHostProps {
  pluginName: string;
  pageId: string;
  /** Arbitrary key-value params forwarded to the iframe as URL query and init message. */
  params?: Record<string, string>;
  minHeight?: number;
  className?: string;
}

interface PluginPagePushPayload {
  pluginName: string;
  pageId: string;
  action: string;
  data?: unknown;
}

export const PluginIframeHost: React.FC<PluginIframeHostProps> = ({
  pluginName,
  pageId,
  params,
  minHeight = 300,
  className,
}) => {
  const { i18n } = useTranslation();
  // ConnectionContext is optional — PluginIframeHost may render outside
  // RadioProvider (e.g. on the standalone LogbookPage). When absent, WebSocket
  // push forwarding is simply disabled.
  const connection = useContext(ConnectionContext);
  const radioService = connection?.state.radioService ?? null;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const [loading, setLoading] = useState(true);

  // Resolve the current effective theme from the DOM
  const getTheme = useCallback((): 'dark' | 'light' => {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }, []);

  // Build iframe src URL — include locale and theme so the page can use them
  // before the async tx5dr:init postMessage arrives.
  const iframeSrc = React.useMemo(() => {
    const query = new URLSearchParams(params);
    query.set('_locale', i18n.language);
    query.set('_theme', getTheme());
    const jwt = getStoredJwt();
    if (jwt) {
      query.set('auth_token', jwt);
    }
    return `/api/plugins/${encodeURIComponent(pluginName)}/ui/${encodeURIComponent(pageId)}.html?${query.toString()}`;
  }, [pluginName, pageId, params, i18n.language, getTheme]);

  // Send a message to the iframe
  const postToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // Handle invoke requests by forwarding to the server
  const handleInvoke = useCallback(async (
    action: string,
    data: unknown,
    requestId: string,
  ) => {
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginName)}/ui-invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ pageId, action, data }),
      });
      const json = await response.json() as { result?: unknown; error?: string };
      if (!response.ok) {
        postToIframe({ type: 'tx5dr:response', requestId, error: json.error ?? 'Request failed' });
      } else {
        postToIframe({ type: 'tx5dr:response', requestId, result: json.result });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      postToIframe({ type: 'tx5dr:response', requestId, error: message });
    }
  }, [pluginName, pageId, postToIframe]);

  // Handle store operations by forwarding to the server
  const handleStoreOp = useCallback(async (
    type: string,
    payload: Record<string, unknown>,
    requestId: string,
  ) => {
    try {
      const action = type.replace('tx5dr:store:', 'store_');
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginName)}/ui-invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ pageId, action, data: payload }),
      });
      const json = await response.json() as { result?: unknown; error?: string };
      postToIframe({ type: 'tx5dr:response', requestId, result: json.result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      postToIframe({ type: 'tx5dr:response', requestId, error: message });
    }
  }, [pluginName, pageId, postToIframe]);

  // Listen for postMessage from the iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('tx5dr:')) return;

      switch (msg.type) {
        case 'tx5dr:invoke':
          void handleInvoke(msg.action, msg.data, msg.requestId);
          break;

        case 'tx5dr:store:get':
        case 'tx5dr:store:set':
        case 'tx5dr:store:delete':
          void handleStoreOp(msg.type, msg, msg.requestId);
          break;

        case 'tx5dr:file:upload':
        case 'tx5dr:file:read':
        case 'tx5dr:file:delete':
        case 'tx5dr:file:list':
          void handleStoreOp(msg.type, msg, msg.requestId);
          break;

        case 'tx5dr:resize':
          if (typeof msg.height === 'number' && msg.height > 0) {
            setHeight(Math.max(msg.height, minHeight));
          }
          break;

        case 'tx5dr:request-close':
          // Bubble up as a custom DOM event for parent components to handle
          iframeRef.current?.dispatchEvent(
            new CustomEvent('plugin-request-close', { bubbles: true }),
          );
          break;

        default:
          logger.debug('Unknown iframe message type', { type: msg.type });
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handleInvoke, handleStoreOp, minHeight]);

  // Send init message when iframe loads
  const handleIframeLoad = useCallback(() => {
    setLoading(false);
    postToIframe({
      type: 'tx5dr:init',
      params: params ?? {},
      theme: getTheme(),
      locale: i18n.language,
    });
  }, [postToIframe, params, getTheme, i18n.language]);

  // Observe theme changes on <html> element and forward to iframe
  useEffect(() => {
    const observer = new MutationObserver(() => {
      postToIframe({
        type: 'tx5dr:theme-changed',
        theme: getTheme(),
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, [postToIframe, getTheme]);

  // Forward plugin push messages from WebSocket to iframe.
  // radioService may be null when rendered outside RadioProvider (e.g. LogbookPage).
  useWSEvent(
    radioService,
    'pluginPagePush',
    (payload: PluginPagePushPayload) => {
      if (payload.pluginName === pluginName && payload.pageId === pageId) {
        postToIframe({
          type: 'tx5dr:push',
          action: payload.action,
          data: payload.data,
        });
      }
    },
  );

  return (
    <div className={className} style={{ position: 'relative', minHeight }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size="sm" />
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        onLoad={handleIframeLoad}
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{
          width: '100%',
          height,
          border: 'none',
          background: 'transparent',
          display: loading ? 'none' : 'block',
        }}
        title={`${pluginName}/${pageId}`}
      />
    </div>
  );
};
