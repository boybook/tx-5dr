import React, { useState, useEffect } from 'react';
import { Card, CardBody, CardHeader } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { api } from '@tx5dr/core';
import type { StationInfo } from '@tx5dr/contracts';
import { StationInfoCard } from '../components/StationInfoCard';
import { AuthLoginForm } from '../components/AuthLoginForm';

export function LoginPage() {
  const { t } = useTranslation();
  const [helpExpanded, setHelpExpanded] = useState(false);
  const [stationInfo, setStationInfo] = useState<StationInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getStationInfo().then(resp => {
      if (!cancelled) setStationInfo(resp.data);
    }).catch(() => { /* silent failure — station info is non-essential */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="app-viewport-min-height w-full overflow-y-auto bg-default-50 flex flex-col items-center justify-center py-6">
      {stationInfo && <StationInfoCard stationInfo={stationInfo} />}
      <Card className="w-full max-w-md mx-4">
        <CardHeader className="flex flex-col items-center gap-2 pt-8 pb-2">
          <h1 className="text-2xl font-bold">TX-5DR</h1>
          <p className="text-default-500 text-sm">{t('auth:loginPage.subtitle')}</p>
        </CardHeader>
        <CardBody className="gap-4 px-8 pb-8">
          <AuthLoginForm autoFocus />

          {/* 折叠式帮助文字 */}
          <div className="mt-1">
            <button
              type="button"
              className="text-xs text-default-400 hover:text-default-500 transition-colors flex items-center gap-1 cursor-pointer"
              onClick={() => setHelpExpanded(!helpExpanded)}
            >
              <FontAwesomeIcon
                icon={helpExpanded ? faChevronDown : faChevronRight}
                className="text-[10px]"
              />
              {t('auth:loginPage.helpTitle')}
            </button>
            {helpExpanded && (
              <p className="text-xs text-default-400 mt-1.5 pl-3.5 leading-relaxed">
                {t('auth:loginPage.helpContent')}
              </p>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
