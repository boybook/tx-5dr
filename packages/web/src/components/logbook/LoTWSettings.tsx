import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Input,
  Spinner,
  Switch,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCertificate,
  faCheck,
  faExclamationTriangle,
  faSync,
  faTrash,
  faUpload,
  faUser,
} from '@fortawesome/free-solid-svg-icons';
import { api, ApiError } from '@tx5dr/core';
import type {
  LoTWCertificateSummary,
  LoTWConfig,
  LoTWUploadIssue,
  LoTWUploadLocation,
  LoTWUploadPreflightResponse,
} from '@tx5dr/contracts';
import { getLoTWLocationRule } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../utils/dateFormatting';
import { showErrorToast } from '../../utils/errorToast';

export interface LoTWSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface LoTWSettingsProps {
  callsign: string;
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

const createDefaultConfig = (callsign: string): LoTWConfig => ({
  username: '',
  password: '',
  certificates: [],
  uploadLocation: {
    callsign: callsign.toUpperCase(),
    gridSquare: '',
    cqZone: '',
    ituZone: '',
    iota: '',
    state: '',
    county: '',
  },
  autoUploadQSO: false,
});

export const LoTWSettings = forwardRef<LoTWSettingsRef, LoTWSettingsProps>(({ callsign, onUnsavedChanges }, ref) => {
  const { t } = useTranslation('logbook');
  const [config, setConfig] = useState<LoTWConfig>(createDefaultConfig(callsign));
  const [originalConfig, setOriginalConfig] = useState<LoTWConfig>(createDefaultConfig(callsign));
  const [loading, setLoading] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [uploadingCertificate, setUploadingCertificate] = useState(false);
  const [deletingCertificateId, setDeletingCertificateId] = useState<string | null>(null);
  const [checkingUpload, setCheckingUpload] = useState(false);
  const [uploadPreflight, setUploadPreflight] = useState<LoTWUploadPreflightResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const locationRule = getLoTWLocationRule(config.uploadLocation?.dxccId);
  const uploadReadyForAuto = Boolean(
    config.certificates.length > 0
    && config.uploadLocation.callsign
    && config.uploadLocation.dxccId
    && config.uploadLocation.gridSquare
    && config.uploadLocation.cqZone
    && config.uploadLocation.ituZone
    && (!locationRule.requiresState || config.uploadLocation.state)
    && (!locationRule.requiresCounty || config.uploadLocation.county)
  );

  const getIssueMessage = (issue: LoTWUploadIssue) => {
    const key = 'lotwSettings.issue.' + issue.code;
    const translated = t(key);
    return translated === key ? issue.message : translated;
  };

  const getGuidanceMessage = (guidanceKey: string) => {
    const key = 'lotwSettings.guidance.' + guidanceKey;
    const translated = t(key);
    return translated === key ? guidanceKey : translated;
  };

  const translateServerMessage = (message: string) => {
    const key = 'lotwSettings.serverError.' + message;
    const translated = t(key);
    return translated === key ? message : translated;
  };

  const getDisplayError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError) {
      return translateServerMessage(err.message) || err.userMessage || fallback;
    }
    if (err instanceof Error) {
      return translateServerMessage(err.message) || err.message;
    }
    return fallback;
  };

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => hasChanges,
    save: handleSave,
  }));

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await api.getLoTWConfig(callsign) as Record<string, unknown>;
      const data = (response?.config || response) as Partial<LoTWConfig> | undefined;
      const nextConfig: LoTWConfig = {
        ...createDefaultConfig(callsign),
        ...(data || {}),
        certificates: data?.certificates || [],
        uploadLocation: {
          ...createDefaultConfig(callsign).uploadLocation,
          ...(data?.uploadLocation || {}),
          callsign: data?.uploadLocation?.callsign || callsign,
        },
      };
      setConfig(nextConfig);
      setOriginalConfig(nextConfig);
      setUploadPreflight(null);
    } catch (err) {
      setError(getDisplayError(err, t('lotwSettings.loadConfigFailed')));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, [callsign]);

  useEffect(() => {
    const changed = JSON.stringify(config) !== JSON.stringify(originalConfig);
    setHasChanges(changed);
    onUnsavedChanges?.(changed);
  }, [config, originalConfig, onUnsavedChanges]);

  const updateField = (field: keyof LoTWConfig, value: string | boolean | LoTWCertificateSummary[] | LoTWUploadLocation) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    if (field === 'username' || field === 'password') {
      setTestResult(null);
    }
    if (field === 'uploadLocation' || field === 'certificates') {
      setUploadPreflight(null);
    }
  };

  const updateLocation = (field: keyof LoTWUploadLocation, value: string | number | undefined) => {
    setConfig((prev) => ({
      ...prev,
      uploadLocation: {
        ...prev.uploadLocation,
        [field]: value,
      },
    }));
    setUploadPreflight(null);
  };

  async function handleSave() {
    try {
      setError('');
      await api.updateLoTWConfig(callsign, config);
      setOriginalConfig({ ...config });
      setHasChanges(false);
      onUnsavedChanges?.(false);
    } catch (err) {
      setError(getDisplayError(err, t('lotwSettings.saveConfigFailed')));
      throw err;
    }
  }

  const testConnection = async () => {
    if (!config.username || !config.password) {
      setTestResult({ success: false, message: t('lotwSettings.fillUsernamePassword') });
      return;
    }

    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const result = await api.testLoTWConnection(callsign, {
        username: config.username,
        password: config.password,
      });
      setTestResult({
        ...result,
        message: translateServerMessage(result.message),
      });
    } catch (err) {
      const message = getDisplayError(err, t('lotwSettings.verifyFailed'));
      setTestResult({
        success: false,
        message,
      });
    } finally {
      setTesting(false);
    }
  };

  const triggerCertificatePicker = () => {
    fileInputRef.current?.click();
  };

  const handleCertificateSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setUploadingCertificate(true);
    setError('');
    try {
      await api.importLoTWCertificate(callsign, file);
      await loadConfig();
    } catch (err) {
      const message = getDisplayError(err, t('lotwSettings.certificateImportFailed'));
      setError(message);
      showErrorToast({
        userMessage: message,
        severity: err instanceof ApiError ? err.severity : 'error',
        suggestions: err instanceof ApiError ? err.suggestions : undefined,
        code: err instanceof ApiError ? err.code : undefined,
      });
    } finally {
      setUploadingCertificate(false);
    }
  };

  const deleteCertificate = async (certId: string) => {
    setDeletingCertificateId(certId);
    setError('');
    try {
      await api.deleteLoTWCertificate(callsign, certId);
      await loadConfig();
    } catch (err) {
      setError(getDisplayError(err, t('lotwSettings.certificateDeleteFailed')));
    } finally {
      setDeletingCertificateId(null);
    }
  };

  const checkUploadReadiness = async () => {
    setCheckingUpload(true);
    setError('');
    try {
      const result = await api.getLoTWUploadPreflight(callsign);
      setUploadPreflight(result);
    } catch (err) {
      setError(getDisplayError(err, t('lotwSettings.uploadCheckFailed')));
    } finally {
      setCheckingUpload(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <Spinner size="md" />
        <span>{t('lotwSettings.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">{t('lotwSettings.title')}</h3>
        <p className="text-sm text-default-500 mt-1">{t('lotwSettings.description')}</p>
      </div>

      {error && (
        <Alert color="danger" title={t('lotwSettings.errorTitle')}>
          <p className="font-medium">{error}</p>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faUser} className="text-primary" />
            <span className="font-medium">{t('lotwSettings.account')}</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <Input
            label={t('lotwSettings.usernameLabel')}
            placeholder={t('lotwSettings.usernamePlaceholder')}
            value={config.username}
            onChange={(event) => updateField('username', event.target.value)}
            description={t('lotwSettings.usernameDesc')}
          />
          <Input
            label={t('lotwSettings.passwordLabel')}
            placeholder={t('lotwSettings.passwordPlaceholder')}
            value={config.password}
            onChange={(event) => updateField('password', event.target.value)}
            type="password"
            description={t('lotwSettings.passwordDesc')}
          />
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              color="primary"
              variant="flat"
              onPress={testConnection}
              isLoading={testing}
              isDisabled={!config.username || !config.password}
              startContent={!testing ? <FontAwesomeIcon icon={faCheck} /> : undefined}
            >
              {testing ? t('lotwSettings.verifying') : t('lotwSettings.verifyAccount')}
            </Button>
            {testResult && (
              <Chip color={testResult.success ? 'success' : 'danger'} variant="flat">
                {testResult.message}
              </Chip>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faCertificate} className="text-primary" />
            <span className="font-medium">{t('lotwSettings.certificateTitle')}</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <Alert color="primary">
            <div className="space-y-2 text-sm">
              <p>{t('lotwSettings.certificateIntro')}</p>
              <ol className="list-decimal pl-5 space-y-1 text-xs text-default-700">
                <li>{t('lotwSettings.certificateStep1')}</li>
                <li>{t('lotwSettings.certificateStep2')}</li>
                <li>{t('lotwSettings.certificateStep3')}</li>
                <li>{t('lotwSettings.certificateStep4')}</li>
              </ol>
            </div>
          </Alert>

          <input
            ref={fileInputRef}
            type="file"
            accept=".p12,.P12"
            className="hidden"
            onChange={handleCertificateSelected}
          />

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              color="primary"
              variant="flat"
              onPress={triggerCertificatePicker}
              isLoading={uploadingCertificate}
              startContent={!uploadingCertificate ? <FontAwesomeIcon icon={faUpload} /> : undefined}
            >
              {uploadingCertificate ? t('lotwSettings.certificateUploading') : t('lotwSettings.certificateUploadButton')}
            </Button>
            <Chip color={config.certificates.length > 0 ? 'success' : 'warning'} variant="flat">
              {t('lotwSettings.certificateCount', { count: config.certificates.length })}
            </Chip>
          </div>

          <div className="space-y-3">
            {config.certificates.length === 0 ? (
              <Alert color="warning" variant="flat">
                {t('lotwSettings.certificateEmpty')}
              </Alert>
            ) : config.certificates.map((certificate) => (
              <div key={certificate.id} className="rounded-xl border border-divider p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{certificate.callsign}</p>
                    <p className="text-xs text-default-500">{t('lotwSettings.certificateDxcc', { dxcc: certificate.dxccId, serial: certificate.serial })}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip color={certificate.status === 'valid' ? 'success' : 'warning'} size="sm" variant="flat">
                      {t('lotwSettings.certificateStatus.' + certificate.status)}
                    </Chip>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      color="danger"
                      onPress={() => deleteCertificate(certificate.id)}
                      isLoading={deletingCertificateId === certificate.id}
                    >
                      <FontAwesomeIcon icon={faTrash} />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-default-600">
                  <p>{t('lotwSettings.certificateValidRange', { from: formatDateTime(certificate.validFrom), to: formatDateTime(certificate.validTo) })}</p>
                  <p>{t('lotwSettings.certificateQsoRange', { from: formatDateTime(certificate.qsoStartDate), to: formatDateTime(certificate.qsoEndDate) })}</p>
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faCertificate} className="text-primary" />
            <span className="font-medium">{t('lotwSettings.locationTitle')}</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-default-500">{t('lotwSettings.locationIntro')}</p>
          <Input
            label={t('lotwSettings.locationCallsignLabel')}
            value={config.uploadLocation.callsign}
            onChange={(event) => updateLocation('callsign', event.target.value.toUpperCase())}
            description={t('lotwSettings.locationCallsignDesc')}
          />
          <Input
            type="number"
            label={t('lotwSettings.locationDxccLabel')}
            value={config.uploadLocation.dxccId ? String(config.uploadLocation.dxccId) : ''}
            onChange={(event) => updateLocation('dxccId', event.target.value ? Number(event.target.value) : undefined)}
            description={t('lotwSettings.locationDxccDesc')}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t('lotwSettings.locationGridLabel')}
              value={config.uploadLocation.gridSquare}
              onChange={(event) => updateLocation('gridSquare', event.target.value.toUpperCase())}
            />
            <Input
              label={t('lotwSettings.locationIotaLabel')}
              value={config.uploadLocation.iota}
              onChange={(event) => updateLocation('iota', event.target.value.toUpperCase())}
            />
            <Input
              label={t('lotwSettings.locationCqLabel')}
              value={config.uploadLocation.cqZone}
              onChange={(event) => updateLocation('cqZone', event.target.value)}
            />
            <Input
              label={t('lotwSettings.locationItuLabel')}
              value={config.uploadLocation.ituZone}
              onChange={(event) => updateLocation('ituZone', event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t('lotwSettings.locationStateLabel', { label: locationRule.stateLabel })}
              value={config.uploadLocation.state}
              onChange={(event) => updateLocation('state', event.target.value.toUpperCase())}
              isRequired={locationRule.requiresState}
              description={t('lotwSettings.locationStateDesc', { label: locationRule.stateLabel })}
            />
            <Input
              label={t('lotwSettings.locationCountyLabel', { label: locationRule.countyLabel || t('lotwSettings.locationCountyFallback') })}
              value={config.uploadLocation.county}
              onChange={(event) => updateLocation('county', event.target.value.toUpperCase())}
              isRequired={locationRule.requiresCounty}
              description={t('lotwSettings.locationCountyDesc', { label: locationRule.countyLabel || t('lotwSettings.locationCountyFallback') })}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faSync} className="text-primary" />
            <span className="font-medium">{t('lotwSettings.syncOptions')}</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <Switch
            isSelected={config.autoUploadQSO}
            onValueChange={(value) => updateField('autoUploadQSO', value)}
            isDisabled={!uploadReadyForAuto}
          >
            {t('lotwSettings.autoUpload')}
          </Switch>
          <p className="text-xs text-default-500 -mt-2">{t('lotwSettings.autoUploadDesc')}</p>

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              color="primary"
              variant="flat"
              onPress={checkUploadReadiness}
              isLoading={checkingUpload}
              startContent={!checkingUpload ? <FontAwesomeIcon icon={faCheck} /> : undefined}
            >
              {checkingUpload ? t('lotwSettings.uploadChecking') : t('lotwSettings.checkUploadReady')}
            </Button>
            {uploadPreflight && (
              <Chip color={uploadPreflight.ready ? 'success' : 'warning'} variant="flat">
                {uploadPreflight.ready ? t('lotwSettings.uploadReady') : t('lotwSettings.uploadNeedsAttention')}
              </Chip>
            )}
          </div>

          {uploadPreflight && (
            <Alert color={uploadPreflight.ready ? 'success' : 'warning'}>
              <div className="space-y-2 text-sm">
                <p className="font-medium">
                  {uploadPreflight.ready ? t('lotwSettings.uploadReadySummary') : t('lotwSettings.uploadPendingSummary')}
                </p>
                <p>{t('lotwSettings.uploadCounts', { pending: uploadPreflight.pendingCount, ready: uploadPreflight.uploadableCount, blocked: uploadPreflight.blockedCount })}</p>
                {uploadPreflight.selectedCertificates.length > 0 && (
                  <ul className="text-xs space-y-1">
                    {uploadPreflight.selectedCertificates.map((certificate) => (
                      <li key={certificate.id}>• {t('lotwSettings.uploadCertificateItem', { callsign: certificate.callsign, from: formatDateTime(certificate.qsoStartDate), to: formatDateTime(certificate.qsoEndDate) })}</li>
                    ))}
                  </ul>
                )}
                {uploadPreflight.issues.length > 0 && (
                  <ul className="text-xs space-y-1">
                    {uploadPreflight.issues.map((issue) => (
                      <li key={issue.code + issue.message}>• {getIssueMessage(issue)}</li>
                    ))}
                  </ul>
                )}
                {uploadPreflight.guidance.length > 0 && (
                  <ul className="text-xs space-y-1">
                    {uploadPreflight.guidance.map((item) => (
                      <li key={item}>• {getGuidanceMessage(item)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Alert>
          )}
        </CardBody>
      </Card>

      {(config.lastUploadTime || config.lastDownloadTime) && (
        <Card>
          <CardBody className="text-sm text-default-600 space-y-1">
            {config.lastUploadTime ? <p>{t('lotwSettings.lastUpload', { time: formatDateTime(config.lastUploadTime) })}</p> : null}
            {config.lastDownloadTime ? <p>{t('lotwSettings.lastDownload', { time: formatDateTime(config.lastDownloadTime) })}</p> : null}
          </CardBody>
        </Card>
      )}

      <div className="rounded-xl bg-default-50 p-4">
        <div className="flex items-center gap-2 mb-2">
          <FontAwesomeIcon icon={faExclamationTriangle} className="text-warning-500" />
          <span className="text-sm font-medium">{t('lotwSettings.usageTitle')}</span>
        </div>
        <ul className="text-xs text-default-600 space-y-1">
          <li>• {t('lotwSettings.usage1')}</li>
          <li>• {t('lotwSettings.usage2')}</li>
          <li>• {t('lotwSettings.usage3')}</li>
          <li>• {t('lotwSettings.usage4')}</li>
        </ul>
      </div>
    </div>
  );
});

LoTWSettings.displayName = 'LoTWSettings';
