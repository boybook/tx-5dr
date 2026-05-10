import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExternalLinkAlt } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { extractBaseCallsign, isValidCallsign } from '@tx5dr/core';
import { openExternal } from '../../utils/openExternal';

const QRZ_CALLSIGN_BASE_URL = 'https://www.qrz.com/db/';

export function normalizeQrzCallsign(callsign: string | null | undefined): string {
  return (callsign ?? '').trim().toUpperCase();
}

export function isValidQrzCallsign(callsign: string | null | undefined): boolean {
  const normalized = normalizeQrzCallsign(callsign);
  if (!normalized) return false;
  if (isValidCallsign(normalized)) return true;

  const baseCallsign = extractBaseCallsign(normalized);
  return baseCallsign !== normalized && isValidCallsign(baseCallsign);
}

export function buildQrzCallsignUrl(callsign: string | null | undefined): string | null {
  const normalized = normalizeQrzCallsign(callsign);
  if (!isValidQrzCallsign(normalized)) return null;
  return `${QRZ_CALLSIGN_BASE_URL}${encodeURIComponent(normalized)}`;
}

export interface QrzCallsignLinkProps {
  callsign: string | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
  stopPropagation?: boolean;
  onClickCapture?: React.MouseEventHandler<HTMLButtonElement>;
}

export const QrzCallsignLink: React.FC<QrzCallsignLinkProps> = ({
  callsign,
  size = 'sm',
  className = '',
  ariaLabel,
  stopPropagation = true,
  onClickCapture,
}) => {
  const { t } = useTranslation('common');
  const normalized = normalizeQrzCallsign(callsign);
  const url = buildQrzCallsignUrl(normalized);

  if (!url) return null;

  const label = ariaLabel || t('callsign.qrzLinkTitle', { callsign: normalized });
  const sizeClass = size === 'md' ? 'text-sm h-6 w-6' : 'text-xs h-5 w-5';

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded text-default-400 transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${sizeClass} ${className}`}
      onClickCapture={onClickCapture}
      onMouseDown={(event) => {
        if (stopPropagation) event.stopPropagation();
      }}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        openExternal(url);
      }}
    >
      <FontAwesomeIcon icon={faExternalLinkAlt} size={size === 'md' ? 'sm' : 'xs'} />
    </button>
  );
};
