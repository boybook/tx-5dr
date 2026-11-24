import { getBandFromFrequency } from '@tx5dr/core';
import { escapeGlobeLabelText, type ReceptionStation } from './receptionGlobe';
import type { ReceptionTheme } from './receptionThemes';

/**
 * Hover card of a receiver on the logbook globe, as an HTML string for the
 * globe.gl tooltip. It is laid out to be read at a glance: who heard us, how
 * strongly, how far away and how long ago, with colour and icons carrying
 * most of it. Every external value is escaped.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Marks the card so the stylesheet can drop the default tooltip frame around it. */
export const RECEPTION_POINT_CARD_CLASS = 'globe-reception-card';

const SNR_LEVEL_COLORS = ['rgb(248, 113, 113)', 'rgb(250, 204, 21)', 'rgb(163, 230, 53)', 'rgb(74, 222, 128)'];
const EMPTY_BAR_COLOR = 'rgba(148, 163, 184, 0.25)';
const MUTED = 'rgba(148, 163, 184, 0.95)';
const FAINT = 'rgba(148, 163, 184, 0.65)';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const PIN_ICON = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 14.5s4.5-4.2 4.5-7.7A4.5 4.5 0 0 0 3.5 6.8C3.5 10.3 8 14.5 8 14.5Z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="6.8" r="1.6" fill="currentColor"/></svg>';
const CLOCK_ICON = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/** 1 (marginal) to 4 (strong); 0 when no report was given. */
export function getSnrLevel(snr: number | undefined): number {
  if (snr === undefined) return 0;
  if (snr >= -5) return 4;
  if (snr >= -12) return 3;
  if (snr >= -18) return 2;
  return 1;
}

function chip(text: string, background: string, color: string): string {
  return `<span style="padding:1px 7px;border-radius:999px;background:${background};color:${color};font-size:11px;font-weight:600;line-height:16px">${escapeGlobeLabelText(text)}</span>`;
}

function snrBars(level: number): string {
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
  const snrColor = level > 0 ? SNR_LEVEL_COLORS[level - 1] : MUTED;
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

  return `<div class="${RECEPTION_POINT_CARD_CLASS}" style="min-width:220px;padding:10px 12px;border-radius:12px;background:rgba(15,23,42,0.95);border:1px solid rgba(255,255,255,0.1);box-shadow:0 14px 36px rgba(2,6,23,0.5);font:12px/1.4 system-ui,-apple-system,sans-serif;color:rgba(226,232,240,0.95)">
<div style="display:flex;align-items:center;gap:8px">
<span style="width:8px;height:8px;flex:none;border-radius:50%;background:${theme.swatch};box-shadow:0 0 8px rgba(${theme.accentRgb},0.8)"></span>
<span style="font:600 14px ${MONO};letter-spacing:0.02em">${escapeGlobeLabelText(station.callsign)}</span>
<span style="margin-left:auto;display:flex;gap:4px">${chips}</span>
</div>
<div style="display:flex;align-items:center;gap:8px;margin-top:9px">
${snrBars(level)}
<span style="font:600 13px ${MONO};color:${snrColor}">${station.snr !== undefined ? `${station.snr > 0 ? '+' : ''}${station.snr} dB` : '— dB'}</span>
<span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;color:${MUTED}">${PIN_ICON}<span style="font-family:${MONO}">${escapeGlobeLabelText(station.locator)}</span>${distance}</span>
</div>
<div style="display:flex;align-items:center;gap:5px;margin-top:6px;font-size:11px;color:${MUTED}">
${CLOCK_ICON}<span style="color:rgba(226,232,240,0.95);font-weight:500">${escapeGlobeLabelText(ago)}</span><span style="color:${FAINT}">${utc} UTC</span>
${delaySeconds > 0 ? `<span style="margin-left:auto;color:${FAINT}">${escapeGlobeLabelText(t('globe.receptionReportDelay', { delay: delaySeconds }))}</span>` : ''}
</div>
</div>`;
}
