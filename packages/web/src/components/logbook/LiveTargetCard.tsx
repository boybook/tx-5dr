import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faReply, faXmark } from '@fortawesome/free-solid-svg-icons';
import type { LogbookSelectTargetResult } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { buildLiveDecodeCardBodyHtml, LIVE_DECODE_CARD_FRAME_STYLE } from '../../utils/liveDecodeCard';
import type { LiveStation } from '../../utils/liveDecodes';
import type { TargetOperatorOption } from '../../utils/liveTargeting';

/** How the page lets a pinned card call a station. */
export interface LiveTargeting {
  /** The server accepts target selection from this page. */
  supported: boolean;
  operators: TargetOperatorOption[];
  defaultOperatorId?: string;
  select(operatorId: string, station: LiveStation): Promise<LogbookSelectTargetResult>;
}

interface LiveTargetCardProps {
  station: LiveStation;
  home: { lat: number; lng: number } | null;
  /** Where it was clicked, relative to the globe container. */
  anchor: { x: number; y: number };
  bounds: { width: number; height: number };
  targeting: LiveTargeting | null;
  /** A double click: call as soon as the card opens. */
  autoCall: boolean;
  onClose: () => void;
}

type CallState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'called' | 'queued' }
  | { kind: 'failed'; message: string };

/** A successful call stays visible this long before the card closes. */
const SUCCESS_CLOSE_MS = 1800;
/**
 * A double click calls only if it can within this long of the card opening
 * (the operator list may still be arriving). Later it would key the
 * transmitter at a moment the user did not choose, so the card waits for a
 * click on its button instead.
 */
export const AUTO_CALL_WINDOW_MS = 1500;
const ANCHOR_GAP = 14;

/**
 * A station card pinned by a click, with the action the hover card cannot
 * offer: calling the station. It shows the same content as the hover card in
 * the same frame, so pinning reads as the hover card staying put.
 */
const LiveTargetCard: React.FC<LiveTargetCardProps> = ({ station, home, anchor, bounds, targeting, autoCall, onClose }) => {
  const { t } = useTranslation('logbook');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: anchor.x + ANCHOR_GAP, top: anchor.y + ANCHOR_GAP, origin: 'top left' });
  const [open, setOpen] = useState(false);
  const [operatorId, setOperatorId] = useState(targeting?.defaultOperatorId);
  const [state, setState] = useState<CallState>({ kind: 'idle' });
  const mountedRef = useRef(true);
  const autoCalledRef = useRef(false);
  const openedAtRef = useRef(performance.now());
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const frame = window.requestAnimationFrame(() => setOpen(true));
    return () => {
      mountedRef.current = false;
      window.cancelAnimationFrame(frame);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Opens beside the click, flipped to stay inside the globe.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const flipX = anchor.x + ANCHOR_GAP + element.offsetWidth > bounds.width;
    const flipY = anchor.y + ANCHOR_GAP + element.offsetHeight > bounds.height;
    setPosition({
      left: Math.max(0, flipX ? anchor.x - ANCHOR_GAP - element.offsetWidth : anchor.x + ANCHOR_GAP),
      top: Math.max(0, flipY ? anchor.y - ANCHOR_GAP - element.offsetHeight : anchor.y + ANCHOR_GAP),
      origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`,
    });
  }, [anchor.x, anchor.y, bounds.width, bounds.height, state.kind]);

  // The operator list can arrive after the card opens.
  useEffect(() => {
    if (!operatorId && targeting?.defaultOperatorId) setOperatorId(targeting.defaultOperatorId);
  }, [operatorId, targeting?.defaultOperatorId]);

  const canCall = Boolean(targeting?.supported && operatorId) && state.kind !== 'sending';

  const call = async () => {
    if (!targeting?.supported || !operatorId || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    const result = await targeting.select(operatorId, station);
    if (!mountedRef.current) return;
    if (result.status === 'rejected') {
      setState({ kind: 'failed', message: result.userMessageKey ? t(result.userMessageKey) : t('globe.callFailed') });
      return;
    }
    setState({ kind: result.status });
    closeTimerRef.current = setTimeout(onClose, SUCCESS_CLOSE_MS);
  };

  useEffect(() => {
    if (!autoCall || autoCalledRef.current || !canCall) return;
    autoCalledRef.current = true;
    if (performance.now() - openedAtRef.current > AUTO_CALL_WINDOW_MS) return;
    void call();
    // Calls once per card, and only right after it opens.
  }, [autoCall, canCall]);

  const hint = !targeting?.supported
    ? t('globe.callUnsupported')
    : targeting.operators.length === 0
      ? t('globe.callNoOperator')
      : !operatorId
        ? t('globe.callPickOperator')
        : null;

  return (
    <div
      ref={rootRef}
      className="globe-pop pointer-events-auto absolute left-0 top-0 z-30"
      data-open={open}
      style={{
        left: position.left,
        top: position.top,
        ['--globe-pop-origin' as string]: position.origin,
        ['--globe-pop-shift' as string]: '-4px',
      }}
      role="dialog"
      aria-label={t('globe.callDialog', { callsign: station.callsign })}
    >
      <div
        ref={(element) => {
          if (element) element.style.cssText = `${LIVE_DECODE_CARD_FRAME_STYLE};min-width:260px`;
        }}
      >
        <div dangerouslySetInnerHTML={{ __html: buildLiveDecodeCardBodyHtml(station, home, t) }} />
        <div className="mt-2.5 border-t border-white/10 pt-2.5">
          {targeting && targeting.operators.length > 1 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[rgba(148,163,184,0.95)]">
              <span>{t('globe.callOperator')}</span>
              {targeting.operators.map(option => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setOperatorId(option.id)}
                  aria-pressed={operatorId === option.id}
                  className={`rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${operatorId === option.id
                    ? 'border-[rgba(203,213,225,0.6)] bg-[rgba(203,213,225,0.16)] text-[rgba(248,250,252,0.95)]'
                    : 'border-white/10 text-[rgba(226,232,240,0.7)] hover:border-white/25'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              radius="full"
              color="primary"
              isDisabled={!canCall || state.kind === 'called' || state.kind === 'queued'}
              onPress={() => { void call(); }}
              startContent={state.kind === 'sending'
                ? <Spinner size="sm" color="current" />
                : <FontAwesomeIcon icon={state.kind === 'called' || state.kind === 'queued' ? faCheck : faReply} className="h-3 w-3" />}
              className="font-medium"
            >
              {t('globe.callAction', { callsign: station.callsign })}
            </Button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('globe.callClose')}
              className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-[rgba(148,163,184,0.9)] transition-colors hover:bg-white/10 hover:text-[rgba(248,250,252,0.95)]"
            >
              <FontAwesomeIcon icon={faXmark} className="h-3 w-3" />
            </button>
          </div>
          <p
            role="status"
            className={`mt-2 text-[11px] leading-snug ${state.kind === 'failed'
              ? 'text-[rgb(251,191,36)]'
              : state.kind === 'called' || state.kind === 'queued'
                ? 'text-[rgb(74,222,128)]'
                : 'text-[rgba(148,163,184,0.75)]'}`}
          >
            {state.kind === 'sending'
              ? t('globe.callSending')
              : state.kind === 'called'
                ? t('globe.callSent', { callsign: station.callsign })
                : state.kind === 'queued'
                  ? t('globe.callQueued', { callsign: station.callsign })
                  : state.kind === 'failed'
                    ? state.message
                    : hint ?? t('globe.callDoubleClickHint')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default LiveTargetCard;
