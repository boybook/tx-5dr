import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Input,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Select,
  SelectItem,
  Spinner,
  Textarea,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faPlus,
  faTrash,
  faPen,
  faCheck,
  faPlay,
  faStop,
  faWifi,
  faSatelliteDish,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { OpenWebRXStationConfig, OpenWebRXListenStatus, OpenWebRXProfile } from '@tx5dr/contracts';
import { useAudioMonitorPlayback } from '../../hooks/useAudioMonitorPlayback';
import { createLogger } from '../../utils/logger';
import {
  presentRealtimeConnectivityFailure,
} from '../../realtime/realtimeConnectivity';

const logger = createLogger('OpenWebRXSettings');

/**
 * OpenWebRX SDR station management settings panel.
 * Provides CRUD for stations, connection testing, and live audio listening.
 */
export function OpenWebRXSettings() {
  const { t } = useTranslation('settings');

  // Station list
  const [stations, setStations] = useState<OpenWebRXStationConfig[]>([]);
  const [loading, setLoading] = useState(true);

  // Add/Edit form
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formDescription, setFormDescription] = useState('');

  // Test connection (per-station)
  const [testingStationId, setTestingStationId] = useState<string | null>(null);
  const [testingFormUrl, setTestingFormUrl] = useState(false);
  const [testResult, setTestResult] = useState<{ stationId?: string; success: boolean; version?: string; profileCount?: number; error?: string } | null>(null);

  // Listen session — bound to a specific station
  const [listenStationId, setListenStationId] = useState<string | null>(null);
  const [listenStatus, setListenStatus] = useState<OpenWebRXListenStatus | null>(null);
  const [listenProfileId, setListenProfileId] = useState('');
  const [listenFrequency, setListenFrequency] = useState('14074000');
  const [listenModulation, setListenModulation] = useState('usb');
  const [isStartingListen, setIsStartingListen] = useState(false);
  // Available profiles fetched when opening listen panel (before starting)
  const [listenProfiles, setListenProfiles] = useState<OpenWebRXProfile[]>([]);
  const [isFetchingProfiles, setIsFetchingProfiles] = useState(false);

  // Audio playback via reusable hook
  const audioPlayback = useAudioMonitorPlayback({
    scope: 'openwebrx-preview',
    previewSessionId: listenStatus?.previewSessionId ?? null,
  });

  // Load stations
  const loadStations = useCallback(async () => {
    try {
      const result = await api.getOpenWebRXStations();
      setStations(result.stations);
    } catch (error) {
      logger.error('Failed to load stations', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStations();
  }, [loadStations]);

  // Poll listen status
  useEffect(() => {
    if (!listenStatus?.isListening) return;
    const interval = setInterval(async () => {
      try {
        const result = await api.getOpenWebRXListenStatus();
        if (result.status) {
          setListenStatus(result.status);
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [listenStatus?.isListening]);

  // ===== Station CRUD =====

  const handleAddStation = async () => {
    if (!formName || !formUrl) return;
    try {
      const result = await api.addOpenWebRXStation({
        name: formName,
        url: formUrl,
        description: formDescription || undefined,
      });
      setStations(prev => [...prev, result.station]);
      resetForm();
    } catch (error) {
      logger.error('Failed to add station', error);
    }
  };

  const handleUpdateStation = async () => {
    if (!editingId || !formName || !formUrl) return;
    try {
      await api.updateOpenWebRXStation(editingId, {
        name: formName,
        url: formUrl,
        description: formDescription || undefined,
      });
      setStations(prev => prev.map(s =>
        s.id === editingId ? { ...s, name: formName, url: formUrl, description: formDescription || undefined } : s
      ));
      resetForm();
    } catch (error) {
      logger.error('Failed to update station', error);
    }
  };

  const handleDeleteStation = async (id: string) => {
    if (listenStationId === id) {
      await handleStopListen();
    }
    try {
      await api.removeOpenWebRXStation(id);
      setStations(prev => prev.filter(s => s.id !== id));
    } catch (error) {
      logger.error('Failed to delete station', error);
    }
  };

  // ===== Test connection =====

  const handleTestConnection = async (url: string, stationId?: string) => {
    if (stationId) {
      setTestingStationId(stationId);
    } else {
      setTestingFormUrl(true);
    }
    setTestResult(null);
    try {
      const result = await api.testOpenWebRXUrl(url);
      setTestResult({
        stationId,
        success: result.success,
        version: result.serverVersion,
        profileCount: result.profiles?.length,
        error: result.error,
      });
    } catch (error) {
      setTestResult({
        stationId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingStationId(null);
      setTestingFormUrl(false);
    }
  };

  // ===== Listen session =====

  const handleOpenListen = async (stationId: string) => {
    // If already listening, stop and close
    if (listenStationId === stationId) {
      await handleStopListen();
      return;
    }

    // If listening to another station, stop first
    if (listenStationId) {
      await handleStopListen();
    }

    // Close edit form if open (mutually exclusive with listening)
    if (isEditing) {
      resetForm();
    }

    // Open listen panel — fetch available profiles first
    setListenStationId(stationId);
    setListenProfileId('');
    setListenProfiles([]);
    setIsFetchingProfiles(true);
    try {
      const result = await api.testOpenWebRXUrl(
        stations.find(s => s.id === stationId)!.url
      );
      if (result.success && result.profiles) {
        setListenProfiles(result.profiles);
      }
    } catch (error) {
      logger.error('Failed to fetch profiles', error);
    } finally {
      setIsFetchingProfiles(false);
    }
  };

  const handleStartListen = async () => {
    if (!listenStationId || !listenProfileId) return;
    setIsStartingListen(true);
    try {
      await audioPlayback.preparePlaybackFromGesture();
      const result = await api.startOpenWebRXListen({
        stationId: listenStationId,
        profileId: listenProfileId,
        frequency: listenFrequency ? parseInt(listenFrequency) : undefined,
        modulation: listenModulation || undefined,
      });
      setListenStatus(result.status);
      await audioPlayback.start({
        previewSessionId: result.status.previewSessionId,
        transportOverride: 'ws-compat',
      });
    } catch (error) {
      logger.error('Failed to start listen', error);
      audioPlayback.stop();
      presentRealtimeConnectivityFailure(error, {
        scope: 'openwebrx-preview',
        stage: 'connect',
      });
    } finally {
      setIsStartingListen(false);
    }
  };

  const handleStopListen = async () => {
    audioPlayback.stop();
    try {
      await api.stopOpenWebRXListen();
    } catch (error) {
      logger.error('Failed to stop listen', error);
    }
    setListenStatus(null);
    setListenStationId(null);
    setListenProfiles([]);
  };

  const handleTuneListen = async () => {
    try {
      await api.tuneOpenWebRXListen({
        profileId: listenProfileId || undefined,
        frequency: listenFrequency ? parseInt(listenFrequency) : undefined,
        modulation: listenModulation || undefined,
      });
    } catch (error) {
      logger.error('Failed to tune listen', error);
    }
  };

  // ===== Form helpers =====

  const startEdit = async (station: OpenWebRXStationConfig) => {
    // Close listen panel if open (mutually exclusive with editing)
    if (listenStationId) {
      await handleStopListen();
    }
    setIsEditing(true);
    setEditingId(station.id);
    setFormName(station.name);
    setFormUrl(station.url);
    setFormDescription(station.description || '');
  };

  const resetForm = () => {
    setIsEditing(false);
    setEditingId(null);
    setFormName('');
    setFormUrl('');
    setFormDescription('');
    setTestResult(null);
  };

  // ===== Render =====

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Introduction */}
      <Alert color="default" variant="flat" title={t('openwebrx.introTitle')}>
        {t('openwebrx.introDescription')}
      </Alert>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          <FontAwesomeIcon icon={faSatelliteDish} className="mr-2" />
          {t('openwebrx.stationList')}
        </h3>
        {!isEditing && (
          <Button
            color="primary"
            size="sm"
            startContent={<FontAwesomeIcon icon={faPlus} />}
            onPress={() => {
              setIsEditing(true);
              setEditingId(null);
            }}
          >
            {t('openwebrx.addStation')}
          </Button>
        )}
      </div>

      {/* Empty state */}
      {stations.length === 0 && !isEditing && (
        <Card>
          <CardBody className="text-center py-8 text-default-400">
            {t('openwebrx.noStations')}
          </CardBody>
        </Card>
      )}

      {/* Station cards */}
      {stations.map(station => {
        const isListening = listenStationId === station.id;
        const isTesting = testingStationId === station.id;
        const stationTestResult = testResult?.stationId === station.id ? testResult : null;

        return (
          <div key={station.id} className="space-y-2">
            {/* Station card */}
            <Card>
              <CardBody className="flex flex-row items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{station.name}</span>
                    <Chip size="sm" variant="flat" color="primary">SDR</Chip>
                    {isListening && (
                      <Chip size="sm" variant="dot" color="success">
                        {t('openwebrx.listening')}
                      </Chip>
                    )}
                  </div>
                  <p className="text-sm text-default-400 mt-1 truncate">{station.url}</p>
                  {station.description && (
                    <p className="text-sm text-default-500 mt-1">{station.description}</p>
                  )}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Button
                    size="sm"
                    variant="flat"
                    isIconOnly
                    onPress={() => handleTestConnection(station.url, station.id)}
                    isLoading={isTesting}
                    title={t('openwebrx.testConnection')}
                  >
                    <FontAwesomeIcon icon={faWifi} />
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    isIconOnly
                    color={isListening ? 'danger' : 'success'}
                    onPress={() => handleOpenListen(station.id)}
                    isLoading={isStartingListen && listenStationId === station.id}
                    title={isListening ? t('openwebrx.stopListen') : t('openwebrx.startListen')}
                  >
                    <FontAwesomeIcon icon={isListening ? faStop : faPlay} />
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    isIconOnly
                    onPress={() => startEdit(station)}
                    title={t('openwebrx.editStation')}
                  >
                    <FontAwesomeIcon icon={faPen} />
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    color="danger"
                    isIconOnly
                    onPress={() => handleDeleteStation(station.id)}
                    title={t('common:button.delete')}
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </Button>
                </div>
              </CardBody>
            </Card>

            {/* Test result for this station */}
            {stationTestResult && (
              stationTestResult.success ? (
                <Alert color="success" variant="flat">
                  {t('openwebrx.testSuccess', { version: stationTestResult.version, profiles: stationTestResult.profileCount })}
                </Alert>
              ) : (
                <Alert color="danger" variant="flat">
                  {t('openwebrx.testFailed', { error: stationTestResult.error })}
                </Alert>
              )
            )}

            {/* Inline listen panel for this station */}
            {isListening && !listenStatus?.isListening && (
              /* Pre-listen: select profile, frequency, then start */
              <Card className="border border-default-200 dark:border-default-700">
                <CardBody className="space-y-4">
                  {isFetchingProfiles ? (
                    <div className="flex justify-center py-4">
                      <Spinner size="sm" />
                    </div>
                  ) : (
                    <>
                      {/* Profile selector (required) */}
                      <Select
                        label={t('openwebrx.selectProfile')}
                        placeholder={t('openwebrx.selectProfilePlaceholder')}
                        selectedKeys={listenProfileId ? [listenProfileId] : []}
                        onSelectionChange={(keys) => {
                          const id = Array.from(keys)[0] as string;
                          setListenProfileId(id || '');
                        }}
                        size="sm"
                      >
                        {listenProfiles.map((p: OpenWebRXProfile) => (
                          <SelectItem key={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </Select>

                      {/* Frequency + modulation */}
                      <div className="flex gap-3 items-end">
                        <Input
                          label={t('openwebrx.frequency')}
                          placeholder="14074000"
                          value={listenFrequency}
                          onValueChange={setListenFrequency}
                          description={listenFrequency ? `${(parseInt(listenFrequency) / 1000000).toFixed(3)} MHz` : ''}
                          className="flex-1"
                          size="sm"
                        />
                        <Select
                          label={t('openwebrx.modulation')}
                          selectedKeys={[listenModulation]}
                          onSelectionChange={(keys) => setListenModulation(Array.from(keys)[0] as string)}
                          className="w-28"
                          size="sm"
                        >
                          <SelectItem key="usb">USB</SelectItem>
                          <SelectItem key="lsb">LSB</SelectItem>
                          <SelectItem key="am">AM</SelectItem>
                          <SelectItem key="fm">FM</SelectItem>
                          <SelectItem key="cw">CW</SelectItem>
                        </Select>
                      </div>

                      {/* Start button */}
                      <div className="flex justify-end">
                        <Button
                          color="primary"
                          size="sm"
                          isDisabled={!listenProfileId}
                          isLoading={isStartingListen}
                          startContent={<FontAwesomeIcon icon={faPlay} />}
                          onPress={handleStartListen}
                        >
                          {t('openwebrx.startListen')}
                        </Button>
                      </div>
                    </>
                  )}
                </CardBody>
              </Card>
            )}

            {/* Active listen panel */}
            {isListening && listenStatus?.isListening && (
              <Card className="border border-success-200 dark:border-success-800">
                <CardBody className="space-y-4">
                  {/* Connection status */}
                  <div className="flex items-center gap-2">
                    <Chip
                      size="sm"
                      color={listenStatus?.connected ? 'success' : 'danger'}
                      variant="dot"
                    >
                      {listenStatus?.connected ? t('openwebrx.connected') : t('openwebrx.disconnected')}
                    </Chip>
                    {listenStatus?.serverVersion && (
                      <span className="text-sm text-default-400">v{listenStatus.serverVersion}</span>
                    )}
                    {listenStatus?.smeterDb !== undefined && (
                      <span className="text-sm text-default-500 ml-auto">
                        S-Meter: {listenStatus.smeterDb.toFixed(1)} dBFS
                      </span>
                    )}
                  </div>

                  {/* Frequency, modulation, tune controls */}
                  <div className="flex gap-3 items-end">
                    <Input
                      label={t('openwebrx.frequency')}
                      placeholder="14074000"
                      value={listenFrequency}
                      onValueChange={setListenFrequency}
                      description={listenFrequency ? `${(parseInt(listenFrequency) / 1000000).toFixed(3)} MHz` : ''}
                      className="flex-1"
                      size="sm"
                    />
                    <Select
                      label={t('openwebrx.modulation')}
                      selectedKeys={[listenModulation]}
                      onSelectionChange={(keys) => setListenModulation(Array.from(keys)[0] as string)}
                      className="w-28"
                      size="sm"
                    >
                      <SelectItem key="usb">USB</SelectItem>
                      <SelectItem key="lsb">LSB</SelectItem>
                      <SelectItem key="am">AM</SelectItem>
                      <SelectItem key="fm">FM</SelectItem>
                      <SelectItem key="cw">CW</SelectItem>
                    </Select>
                    <Button
                      size="sm"
                      variant="flat"
                      onPress={handleTuneListen}
                    >
                      {t('openwebrx.applyTune')}
                    </Button>
                  </div>

                  {/* Stream info */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-default-400">
                    {listenStatus?.centerFreq && (
                      <span>
                        {t('openwebrx.centerFreq')}: {(listenStatus.centerFreq / 1000000).toFixed(3)} MHz
                        {listenStatus.sampleRate && ` (BW: ${(listenStatus.sampleRate / 1000).toFixed(0)} kHz)`}
                      </span>
                    )}
                    {audioPlayback.isPlaying && (
                      <span>
                        {t('openwebrx.codec')}: <span className="font-mono uppercase">{audioPlayback.codec}</span>
                      </span>
                    )}
                    {audioPlayback.stats && (
                      <>
                        <span>
                          {t('openwebrx.latency')}: <span className="font-mono">{audioPlayback.stats.latencyMs.toFixed(0)}ms</span>
                        </span>
                        <span>
                          {t('openwebrx.buffer')}: <span className="font-mono">{audioPlayback.stats.bufferFillPercent.toFixed(0)}%</span>
                        </span>
                      </>
                    )}
                  </div>

                  {/* Error */}
                  {listenStatus?.error && (
                    <Alert color="danger" variant="flat">
                      {listenStatus.error}
                    </Alert>
                  )}
                </CardBody>
              </Card>
            )}
          </div>
        );
      })}

      {/* Add/Edit Form */}
      {isEditing && (
        <Card>
          <CardHeader>
            <h4 className="font-semibold">
              {editingId ? t('openwebrx.editStation') : t('openwebrx.addStation')}
            </h4>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input
              label={t('openwebrx.stationName')}
              placeholder={t('openwebrx.stationNamePlaceholder')}
              value={formName}
              onValueChange={setFormName}
            />
            <Input
              label={t('openwebrx.stationUrl')}
              placeholder="ws://host:8073"
              value={formUrl}
              onValueChange={setFormUrl}
              description={t('openwebrx.urlDescription')}
            />
            <Textarea
              label={t('openwebrx.stationDescription')}
              placeholder={t('openwebrx.descriptionPlaceholder')}
              value={formDescription}
              onValueChange={setFormDescription}
            />
            {/* Form test result */}
            {testResult && !testResult.stationId && (
              testResult.success ? (
                <Alert color="success" variant="flat">
                  {t('openwebrx.testSuccess', { version: testResult.version, profiles: testResult.profileCount })}
                </Alert>
              ) : (
                <Alert color="danger" variant="flat">
                  {t('openwebrx.testFailed', { error: testResult.error })}
                </Alert>
              )
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="flat" onPress={resetForm}>
                {t('common:button.cancel')}
              </Button>
              <Button
                variant="flat"
                onPress={() => handleTestConnection(formUrl)}
                isLoading={testingFormUrl}
                isDisabled={!formUrl}
              >
                <FontAwesomeIcon icon={faWifi} className="mr-2" />
                {t('openwebrx.testConnection')}
              </Button>
              <Button
                color="primary"
                onPress={editingId ? handleUpdateStation : handleAddStation}
                isDisabled={!formName || !formUrl}
              >
                <FontAwesomeIcon icon={faCheck} className="mr-2" />
                {editingId ? t('common:button.save') : t('openwebrx.addStation')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
