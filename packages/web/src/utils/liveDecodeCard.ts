import { escapeGlobeLabelText } from './receptionGlobe';
import { hexToRgba } from './colorUtils';
import { HighlightType } from './displayNotificationSettings';
import { getDistanceAndBearing, type LiveStation } from './liveDecodes';
import {
  CLOCK_ICON,
  GLOBE_CARD_FAINT,
  GLOBE_CARD_FRAME_STYLE,
  GLOBE_CARD_MONO,
  I_HEARD_ACCENT,
  directionCaptionHtml,
  directionalCardFrameStyle,
  snrSubjectHtml,
  GLOBE_CARD_MUTED,
  PIN_ICON,
  SNR_LEVEL_COLORS,
  chip,
  getSnrLevel,
  snrBars,
} from './receptionPointCard';

/**
 * Hover card of a station heard live, in the order the operator decides:
 * whether it is needed and callable, whether it can be worked (signal), where
 * it is, then what it sent and when. Every external value is escaped.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

const NEED_LABEL_KEYS: Record<HighlightType, string> = {
  [HighlightType.NEW_PREFIX]: 'globe.liveNeedDxcc',
  [HighlightType.NEW_GRID]: 'globe.liveNeedGrid',
  [HighlightType.NEW_CALLSIGN]: 'globe.liveNeedCallsign',
};

/** A highlight colour with transparency; colours that are not hex pass as they are. */
function withAlpha(color: string, alpha: number): string {
  return /^#[0-9a-f]{6}$/i.test(color.trim()) ? hexToRgba(color.trim(), alpha) : color;
}

/** Frame of a heard-station card: the "I heard" direction bar. */
export const LIVE_DECODE_CARD_FRAME_STYLE = directionalCardFrameStyle(I_HEARD_ACCENT);

export function buildLiveDecodeCardHtml(
  station: LiveStation,
  home: { lat: number; lng: number } | null,
  t: Translate,
): string {
  return `<div style="${LIVE_DECODE_CARD_FRAME_STYLE}">${buildLiveDecodeCardBodyHtml(station, home, t)}</div>`;
}

/** The card's content without its frame, for cards that add their own controls. */
export function buildLiveDecodeCardBodyHtml(
  station: LiveStation,
  home: { lat: number; lng: number } | null,
  t: Translate,
): string {
  const { decode } = station;
  const level = getSnrLevel(decode.snr);
  const snrColor = level > 0 ? SNR_LEVEL_COLORS[level - 1] : GLOBE_CARD_MUTED;
  const accent = station.color ?? 'rgba(226, 232, 240, 0.9)';
  const chips = [
    station.highlight ? chip(t(NEED_LABEL_KEYS[station.highlight]), withAlpha(accent, 0.18), accent) : '',
    station.isCq
      ? chip('CQ', 'rgba(226, 232, 240, 0.14)', 'rgba(248, 250, 252, 0.95)')
      : decode.targetCallsign
        ? chip(`→ ${decode.targetCallsign}`, 'rgba(148, 163, 184, 0.14)', GLOBE_CARD_MUTED)
        : '',
  ].join('');
  const place = decode.analysis?.grid ?? decode.analysis?.dxccEntity ?? '';
  const route = home ? getDistanceAndBearing(home, station) : null;
  const routeText = route
    ? ` · ${Math.round(route.distanceKm).toLocaleString()} km · ${Math.round(route.bearingDeg)}°`
    : '';
  const ago = station.ageSlots <= 1
    ? t('globe.liveThisCycle')
    : t('globe.liveSlotsAgo', { count: station.ageSlots });
  const entity = decode.analysis?.dxccEntity && decode.analysis.grid
    ? `<span style="color:${GLOBE_CARD_FAINT}">${escapeGlobeLabelText(decode.analysis.dxccEntity)}</span>`
    : '';

  return `${directionCaptionHtml('iHeard', I_HEARD_ACCENT, t)}
<div style="display:flex;align-items:center;gap:8px">
<span style="width:8px;height:8px;flex:none;transform:rotate(${station.isCq ? 45 : 0}deg);border-radius:${station.isCq ? '1px' : '50%'};background:${accent}"></span>
<span style="font:600 14px ${GLOBE_CARD_MONO};letter-spacing:0.02em">${escapeGlobeLabelText(station.callsign)}</span>
<span style="margin-left:auto;display:flex;gap:4px">${chips}</span>
</div>
<div style="display:flex;align-items:center;gap:8px;margin-top:9px">
${snrSubjectHtml('iHeard', t)}
${snrBars(level)}
<span style="font:600 13px ${GLOBE_CARD_MONO};color:${snrColor}">${decode.snr > 0 ? '+' : ''}${decode.snr} dB</span>
<span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;color:${GLOBE_CARD_MUTED}">${PIN_ICON}<span style="font-family:${GLOBE_CARD_MONO}">${escapeGlobeLabelText(place)}</span>${escapeGlobeLabelText(routeText)}</span>
</div>
<div style="margin-top:6px;font:11px ${GLOBE_CARD_MONO};color:rgba(226,232,240,0.8)">${escapeGlobeLabelText(decode.message)}</div>
<div style="display:flex;align-items:center;gap:5px;margin-top:6px;font-size:11px;color:${GLOBE_CARD_MUTED}">
${CLOCK_ICON}<span style="color:rgba(226,232,240,0.95);font-weight:500">${escapeGlobeLabelText(ago)}</span>${entity}
${station.approximate ? `<span style="margin-left:auto;color:${GLOBE_CARD_FAINT}">${escapeGlobeLabelText(t('globe.liveApproximate'))}</span>` : ''}
</div>`;
}

/** Small card for simple hover text (grid squares, worked stations, home). */
export function buildSimpleGlobeCardHtml(lines: string[]): string {
  const [title, ...rest] = lines;
  return `<div style="${GLOBE_CARD_FRAME_STYLE};min-width:0;padding:7px 10px">
<div style="font:600 12px ${GLOBE_CARD_MONO}">${escapeGlobeLabelText(title ?? '')}</div>
${rest.map(line => `<div style="margin-top:2px;color:${GLOBE_CARD_MUTED}">${escapeGlobeLabelText(line)}</div>`).join('')}
</div>`;
}
