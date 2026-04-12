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
  pageSessionId: string;
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
  const lockedPageSessionIdRef = useRef<string | null>(null);
  const [height, setHeight] = useState(minHeight);
  const [loading, setLoading] = useState(true);
  const [pageSessionId, setPageSessionId] = useState<string | null>(null);

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

  const setLockedPageSessionId = useCallback((nextPageSessionId: string | null) => {
    lockedPageSessionIdRef.current = nextPageSessionId;
    setPageSessionId(nextPageSessionId);
  }, []);

  const requireLockedPageSessionId = useCallback((requestId: string): string | null => {
    const lockedPageSessionId = lockedPageSessionIdRef.current;
    if (!lockedPageSessionId) {
      postToIframe({
        type: 'tx5dr:response',
        requestId,
        error: 'Page session is not ready',
      });
      return null;
    }
    return lockedPageSessionId;
  }, [postToIframe]);

  // Handle invoke requests by forwarding to the server
  const handleInvoke = useCallback(async (
    action: string,
    data: unknown,
    requestId: string,
  ) => {
    const lockedPageSessionId = requireLockedPageSessionId(requestId);
    if (!lockedPageSessionId) {
      return;
    }

    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginName)}/ui-invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ pageId, pageSessionId: lockedPageSessionId, action, data }),
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
  }, [pluginName, pageId, postToIframe, requireLockedPageSessionId]);

  // Handle store operations by forwarding to the server
  const handleStoreRequest = useCallback(async (
    payload: Record<string, unknown>,
    requestId: string,
  ) => {
    const lockedPageSessionId = requireLockedPageSessionId(requestId);
    if (!lockedPageSessionId) {
      return;
    }

    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginName)}/ui-store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          pageId,
          pageSessionId: lockedPageSessionId,
          type: payload.type,
          key: payload.key,
          value: payload.value,
          callsign: payload.callsign,
          operatorId: payload.operatorId,
        }),
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
  }, [pluginName, pageId, postToIframe, requireLockedPageSessionId]);

  const handleFileRequest = useCallback(async (
    payload: Record<string, unknown>,
    requestId: string,
  ) => {
    const lockedPageSessionId = requireLockedPageSessionId(requestId);
    if (!lockedPageSessionId) {
      return;
    }

    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginName)}/ui-files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          pageId,
          pageSessionId: lockedPageSessionId,
          type: payload.type,
          path: payload.path,
          prefix: payload.prefix,
          data: payload.data,
          callsign: payload.callsign,
          operatorId: payload.operatorId,
        }),
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
  }, [pluginName, pageId, postToIframe, requireLockedPageSessionId]);

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
          void handleStoreRequest(msg, msg.requestId);
          break;

        case 'tx5dr:file:upload':
        case 'tx5dr:file:read':
        case 'tx5dr:file:delete':
        case 'tx5dr:file:list':
          void handleFileRequest(msg, msg.requestId);
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
  }, [handleFileRequest, handleInvoke, handleStoreRequest, minHeight]);

  // Send init message when iframe loads
  const handleIframeLoad = useCallback(() => {
    setLoading(false);
    const iframeWindow = iframeRef.current?.contentWindow as (Window & {
      __TX5DR_PAGE_SESSION_ID__?: string;
    }) | null;
    const nextPageSessionId = typeof iframeWindow?.__TX5DR_PAGE_SESSION_ID__ === 'string'
      ? iframeWindow.__TX5DR_PAGE_SESSION_ID__
      : null;
    setLockedPageSessionId(nextPageSessionId);
    postToIframe({
      type: 'tx5dr:init',
      params: params ?? {},
      theme: getTheme(),
      locale: i18n.language,
    });
  }, [postToIframe, params, getTheme, i18n.language, setLockedPageSessionId]);

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

  useEffect(() => {
    setLoading(true);
    setLockedPageSessionId(null);
  }, [iframeSrc, setLockedPageSessionId]);

  useEffect(() => {
    if (!pageSessionId) {
      return;
    }

    let cancelled = false;
    const sendHeartbeat = async () => {
      try {
        const response = await fetch(`/api/plugins/${encodeURIComponent(pluginName)}/ui-session/heartbeat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: JSON.stringify({ pageId, pageSessionId }),
        });
        if (!response.ok && !cancelled) {
          logger.warn('Plugin page heartbeat failed', {
            pluginName,
            pageId,
            pageSessionId,
            status: response.status,
          });
        }
      } catch (err) {
        if (!cancelled) {
          logger.warn('Plugin page heartbeat request failed', {
            pluginName,
            pageId,
            pageSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    void sendHeartbeat();
    const timer = window.setInterval(() => {
      void sendHeartbeat();
    }, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pageSessionId, pluginName, pageId]);

  // Forward plugin push messages from WebSocket to iframe.
  // radioService may be null when rendered outside RadioProvider (e.g. LogbookPage).
  useWSEvent(
    radioService,
    'pluginPagePush',
    (payload: PluginPagePushPayload) => {
      if (
        payload.pluginName === pluginName
        && payload.pageSessionId === pageSessionId
      ) {
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
