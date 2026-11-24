import { getBandFromFrequency } from '@tx5dr/core';
import { faEarListen, faTowerBroadcast, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { escapeGlobeLabelText, type ReceptionStation } from './receptionGlobe';
import type { ReceptionTheme } from './receptionThemes';

/**
 * Hover card of a receiver on the logbook globe, as an HTML string for the
 * globe's hover card, and the card parts every globe station card shares. It
 * is laid out to be read at a glance: who heard us, how strongly, how far
 * away and how long ago, with colour and icons carrying most of it. Every
 * external value is escaped.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Frame shared by every globe hover card. */
export const GLOBE_CARD_FRAME_STYLE = 'min-width:220px;padding:10px 12px;border-radius:12px;background:rgba(15,23,42,0.95);border:1px solid rgba(255,255,255,0.1);box-shadow:0 14px 36px rgba(2,6,23,0.5);font:12px/1.4 system-ui,-apple-system,sans-serif;color:rgba(226,232,240,0.95)';

export const SNR_LEVEL_COLORS = ['rgb(248, 113, 113)', 'rgb(250, 204, 21)', 'rgb(163, 230, 53)', 'rgb(74, 222, 128)'];
const EMPTY_BAR_COLOR = 'rgba(148, 163, 184, 0.25)';
export const GLOBE_CARD_MUTED = 'rgba(148, 163, 184, 0.95)';
export const GLOBE_CARD_FAINT = 'rgba(148, 163, 184, 0.65)';
export const GLOBE_CARD_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export const PIN_ICON = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 14.5s4.5-4.2 4.5-7.7A4.5 4.5 0 0 0 3.5 6.8C3.5 10.3 8 14.5 8 14.5Z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="6.8" r="1.6" fill="currentColor"/></svg>';
export const CLOCK_ICON = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/**
 * Which way a hover card's signal went. Receivers that heard us and stations
 * we heard look alike on a map, so every station card opens with the
 * direction: the toolbar icon of its layer, a caption naming who heard whom
 * and the data source, and a coloured bar down the left edge.
 */
export type GlobeCardDirection = 'heardMe' | 'iHeard';

const DIRECTIONS: Record<GlobeCardDirection, { icon: IconDefinition; titleKey: string; sourceKey: string; snrKey: string }> = {
  heardMe: { icon: faTowerBroadcast, titleKey: 'globe.cardHeardMe', sourceKey: 'globe.cardSourcePskReporter', snrKey: 'globe.cardSnrMine' },
  iHeard: { icon: faEarListen, titleKey: 'globe.cardIHeard', sourceKey: 'globe.cardSourceLocal', snrKey: 'globe.cardSnrTheirs' },
};

/** Colour of the "I heard" direction; neutral, so it never reads as a reception theme or a highlight. */
export const I_HEARD_ACCENT = 'rgb(203, 213, 225)';

/**
 * Colour of the "heard me" direction: the theme's saturated accent. The
 * theme's point colour is pale on purpose (it must stand out on the glow) and
 * in some themes is near white, which would read as the neutral "I heard".
 */
export function getHeardMeAccent(theme: ReceptionTheme): string {
  return `rgb(${theme.accentRgb})`;
}

function iconSvg(icon: IconDefinition, size: number): string {
  const [width, height, , , path] = icon.icon;
  const d = Array.isArray(path) ? path.join(' ') : path;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${width} ${height}" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
}

/** Card frame with the direction's colour bar on the left edge. */
export function directionalCardFrameStyle(accent: string): string {
  return `${GLOBE_CARD_FRAME_STYLE};border-left:3px solid ${accent}`;
}

export function directionCaptionHtml(direction: GlobeCardDirection, accent: string, t: Translate): string {
  const { icon, titleKey, sourceKey } = DIRECTIONS[direction];
  return `<div data-direction="${direction}" style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px;font-weight:600;letter-spacing:0.02em;color:${accent}">${iconSvg(icon, 12)}<span>${escapeGlobeLabelText(t(titleKey))}</span><span style="margin-left:auto;font-weight:400;color:${GLOBE_CARD_FAINT}">${escapeGlobeLabelText(t(sourceKey))}</span></div>`;
}

/** Names whose signal an SNR measures: ours at the receiver, or theirs here. */
export function snrSubjectHtml(direction: GlobeCardDirection, t: Translate): string {
  return `<span style="font-size:11px;color:${GLOBE_CARD_FAINT}">${escapeGlobeLabelText(t(DIRECTIONS[direction].snrKey))}</span>`;
}

/** 1 (marginal) to 4 (strong); 0 when no report was given. */
export function getSnrLevel(snr: number | undefined): number {
  if (snr === undefined) return 0;
  if (snr >= -5) return 4;
  if (snr >= -12) return 3;
  if (snr >= -18) return 2;
  return 1;
}

export function chip(text: string, background: string, color: string): string {
  return `<span style="padding:1px 7px;border-radius:999px;background:${background};color:${color};font-size:11px;font-weight:600;line-height:16px">${escapeGlobeLabelText(text)}</span>`;
}

export function snrBars(level: number): string {
  const color = level > 0 ? SNR_LEVEL_COLORS[level - 1] : EMPTY_BAR_COLOR;
  const bars = [5, 8, 11, 14].map((height, index) => (
    `<span style="width:3px;height:${height}px;border-radius:1px;background:${index < level ? color : EMPTY_BAR_COLOR}"></span>`
  )).join('');
  return `<span style="display:inline-flex;align-items:flex-end;gap:2px;height:14px">${bars}</span>`;
}

export function buildReceptionPointCardHtml(
  station: ReceptionStation,
  theme: ReceptionTheme,
  now: number,
  t: Translate,
): string {
  const level = getSnrLevel(station.snr);
  const snrColor = level > 0 ? SNR_LEVEL_COLORS[level - 1] : GLOBE_CARD_MUTED;
  const band = station.frequency ? getBandFromFrequency(station.frequency) : null;
  const minutesAgo = Math.max(0, Math.floor((now - station.transmittedAt) / 60_000));
  const ago = minutesAgo === 0 ? t('globe.receptionJustNow') : t('globe.receptionMinutesAgo', { count: minutesAgo });
  const utc = new Date(station.transmittedAt).toISOString().slice(11, 16);
  const delaySeconds = Math.round((station.reportedAt - station.transmittedAt) / 1000);
  const chips = [
    band && band !== 'Unknown' ? chip(band, `rgba(${theme.accentRgb}, 0.18)`, `rgb(${theme.pointRgb})`) : '',
    station.mode ? chip(station.mode, 'rgba(148, 163, 184, 0.16)', 'rgba(226, 232, 240, 0.9)') : '',
  ].join('');
  const distance = station.distanceKm !== undefined
    ? ` · ${Math.round(station.distanceKm).toLocaleString()} km`
    : '';

  const accent = getHeardMeAccent(theme);
  return `<div style="${directionalCardFrameStyle(accent)}">
${directionCaptionHtml('heardMe', accent, t)}
<div style="display:flex;align-items:center;gap:8px">
<span style="width:9px;height:9px;flex:none;box-sizing:border-box;border-radius:50%;border:2px solid ${accent};box-shadow:0 0 8px rgba(${theme.accentRgb},0.6)"></span>
<span style="font:600 14px ${GLOBE_CARD_MONO};letter-spacing:0.02em">${escapeGlobeLabelText(station.callsign)}</span>
<span style="margin-left:auto;display:flex;gap:4px">${chips}</span>
</div>
<div style="display:flex;align-items:center;gap:8px;margin-top:9px">
${snrSubjectHtml('heardMe', t)}
${snrBars(level)}
<span style="font:600 13px ${GLOBE_CARD_MONO};color:${snrColor}">${station.snr !== undefined ? `${station.snr > 0 ? '+' : ''}${station.snr} dB` : '— dB'}</span>
<span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;color:${GLOBE_CARD_MUTED}">${PIN_ICON}<span style="font-family:${GLOBE_CARD_MONO}">${escapeGlobeLabelText(station.locator)}</span>${distance}</span>
</div>
<div style="display:flex;align-items:center;gap:5px;margin-top:6px;font-size:11px;color:${GLOBE_CARD_MUTED}">
${CLOCK_ICON}<span style="color:rgba(226,232,240,0.95);font-weight:500">${escapeGlobeLabelText(ago)}</span><span style="color:${GLOBE_CARD_FAINT}">${utc} UTC</span>
${delaySeconds > 0 ? `<span style="margin-left:auto;color:${GLOBE_CARD_FAINT}">${escapeGlobeLabelText(t('globe.receptionReportDelay', { delay: delaySeconds }))}</span>` : ''}
</div>
</div>`;
}
