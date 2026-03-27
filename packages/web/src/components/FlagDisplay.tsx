import React from 'react';
import 'flag-icons/css/flag-icons.min.css';

const isWindows: boolean =
  typeof navigator !== 'undefined' &&
  ((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'Windows' ||
    navigator.platform?.startsWith('Win'));

interface FlagDisplayProps {
  flag?: string;
  countryCode?: string;
}

export const FlagDisplay: React.FC<FlagDisplayProps> = ({ flag, countryCode }) => {
  if (!flag && !countryCode) return null;
  if (isWindows && countryCode) {
    return <span className={`fi fi-${countryCode.toLowerCase()}`} style={{ flexShrink: 0, borderRadius: 1.5, overflow: 'hidden' }} />;
  }
  return flag ? <span>{flag}</span> : null;
};
