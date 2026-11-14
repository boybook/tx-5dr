import React, { useState } from 'react';
import { Button, Input } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBook } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { rttyQsoDraftStore, useRttyQSODraft } from '../../store/rttyQsoDraftStore';
import { useWorkedStatus } from './useWorkedCallsigns';
import { logRttyQso } from './rttyQsoActions';
import { isRttyCallsign } from './rttyText';

function DupeBadge({ callsign }: { callsign: string }) {
  const { t } = useTranslation('radio');
  const status = useWorkedStatus(callsign);
  if (status !== 'dupe') return null;
  return (
    <span className="shrink-0 rounded bg-warning-100 px-1 text-[10px] font-semibold text-warning-700 dark:bg-warning-500/20 dark:text-warning-400">
      {t('rtty.mobile.dupe', 'DUPE')}
    </span>
  );
}

/**
 * Phone-sized QSO strip above the RTTY terminal: the other station's call
 * and the received report from the shared draft, and a Log button that logs
 * through the QSO log card on the other tab, so a QSO can be completed
 * without switching tabs.
 */
export const RttyMobileQsoBar: React.FC = () => {
  const { t } = useTranslation('radio');
  const { hisCallsign, rrst } = useRttyQSODraft();
  const [logging, setLogging] = useState(false);
  const showStatus = isRttyCallsign(hisCallsign);

  const handleLog = async () => {
    setLogging(true);
    try {
      await logRttyQso();
    } finally {
      setLogging(false);
    }
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-content1/80 p-1.5 shadow-sm ring-1 ring-default-200/60" data-testid="rtty-mobile-qso-bar">
      <Input
        size="sm"
        variant="flat"
        aria-label={t('rtty.qso.callsign', 'Callsign')}
        placeholder={t('rtty.qso.callsignPlaceholder', 'Station callsign')}
        value={hisCallsign}
        onValueChange={(value) => rttyQsoDraftStore.setHisCallsign(value)}
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck="false"
        className="min-w-0 flex-1"
        classNames={{ input: 'font-mono font-bold uppercase', inputWrapper: 'h-9 min-h-9' }}
        endContent={showStatus ? <DupeBadge callsign={hisCallsign} /> : null}
      />
      <Input
        size="sm"
        variant="flat"
        aria-label={t('rtty.qso.rstReceived', 'RST Received')}
        value={rrst}
        maxLength={3}
        onValueChange={(value) => rttyQsoDraftStore.setRrst(value.slice(0, 3))}
        startContent={<span className="text-[10px] text-default-400">R</span>}
        className="w-[4.5rem] shrink-0"
        classNames={{ input: 'font-mono uppercase', inputWrapper: 'h-9 min-h-9 px-2' }}
      />
      <Button
        size="sm"
        color="primary"
        className="h-9 shrink-0 px-3"
        startContent={<FontAwesomeIcon icon={faBook} className="text-xs" />}
        isDisabled={!hisCallsign}
        isLoading={logging}
        onPress={() => { void handleLog(); }}
      >
        {t('rtty.mobile.log', 'Log')}
      </Button>
    </div>
  );
};
