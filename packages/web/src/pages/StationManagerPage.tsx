import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComputer, faPlus, faSatelliteDish, faTowerBroadcast } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { DesktopRemoteStationView, DesktopStationsState } from '@tx5dr/contracts';
import { useTheme } from '../hooks/useTheme';
import {
  describeBridgeError,
  openStation,
  openStationManager,
  removeStation,
  trustStationCertificate,
  useDesktopStations,
} from '../utils/desktopStations';
import { StationRow } from '../components/stations/StationRow';
import { StationConnectFlow } from '../components/stations/StationConnectFlow';
import { StationEditorModal, type StationEditorValue } from '../components/stations/StationEditorModal';
import { describeConnectError, displayHost } from '../components/stations/stationText';

const ease = [0.16, 1, 0.3, 1] as const;
const listItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98 },
  transition: { duration: 0.2, ease },
};

/** Keeps the macOS traffic lights and the window drag area clear of controls. */
const TitlebarDragRegion: React.FC = () => (
  <div className="h-10 w-full flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
);

function useStationActions() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeBridgeError(actionError));
    } finally {
      setBusyId(null);
    }
  };
  return { busyId, error, setError, run };
}

const ConnectView: React.FC<{ state: DesktopStationsState; stationId: string }> = ({ state, stationId }) => {
  const { t } = useTranslation('stations');
  const { busyId, error, run } = useStationActions();
  const station = state.profiles.find(profile => profile.id === stationId);
  if (!station) {
    return <Alert color="danger" variant="flat" description={t('errors.unknown', { message: stationId })} />;
  }
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <StationConnectFlow
        station={station}
        connection={state.connections[stationId] ?? null}
        busy={busyId !== null}
        onRetry={() => void run(stationId, () => openStation(stationId))}
        onTrust={fingerprint => void run(stationId, () => trustStationCertificate(stationId, fingerprint))}
        onOpenEmbedded={() => void run(state.embedded.id, () => openStation(state.embedded.id))}
        onManage={() => void openStationManager()}
      />
      {error && <Alert className="max-w-[480px]" color="danger" variant="flat" description={t('errors.unknown', { message: error })} />}
    </div>
  );
};

const ManageView: React.FC<{ state: DesktopStationsState }> = ({ state }) => {
  const { t } = useTranslation('stations');
  const { busyId, error, setError, run } = useStationActions();
  const [editing, setEditing] = useState<StationEditorValue | null>(null);
  const [removing, setRemoving] = useState<DesktopRemoteStationView | null>(null);

  const embeddedStatus = useMemo(() => {
    const status = state.embedded.status;
    const color = status === 'ready' ? 'success' : status === 'starting' ? 'warning' : status === 'failed' ? 'danger' : 'default';
    return { label: t(`status.${status}`), color, loading: status === 'starting' } as const;
  }, [state.embedded.status, t]);

  const open = (id: string) => void run(id, () => openStation(id));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 max-w-[460px] text-small text-default-500">{t('subtitle')}</p>
        </div>
        <Button
          color="primary"
          startContent={<FontAwesomeIcon icon={faPlus} />}
          onPress={() => setEditing({ label: '', url: '' })}
        >
          {t('actions.add')}
        </Button>
      </header>

      <AnimatePresence>
        {error && (
          <motion.div key="error" {...listItem}>
            <Alert color="danger" variant="flat" isClosable onClose={() => setError(null)} description={t('errors.unknown', { message: error })} />
          </motion.div>
        )}
      </AnimatePresence>

      <Card shadow="sm" className="border border-default-100">
        <StationRow
          icon={faComputer}
          title={t('embeddedLabel')}
          subtitle={t('embeddedDescription')}
          isOpen={state.openStationIds.includes(state.embedded.id)}
          isLastUsed={state.activeStationId === state.embedded.id}
          status={embeddedStatus}
          busy={busyId === state.embedded.id}
          onOpen={() => open(state.embedded.id)}
        >
          {state.embedded.error && (
            <Alert color="danger" variant="flat" title={state.embedded.error.title} description={state.embedded.error.message} />
          )}
        </StationRow>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="px-1 text-tiny font-semibold uppercase tracking-wide text-default-500">{t('remoteSection')}</h2>
        <AnimatePresence initial={false} mode="popLayout">
          {state.profiles.length === 0 ? (
            <motion.div key="empty" {...listItem}>
              <Card shadow="none" className="border-2 border-dashed border-default-200 bg-transparent">
                <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
                    <FontAwesomeIcon icon={faSatelliteDish} />
                  </span>
                  <div>
                    <p className="text-medium font-semibold text-foreground">{t('empty.title')}</p>
                    <p className="mx-auto mt-1 max-w-[360px] text-small text-default-500">{t('empty.description')}</p>
                  </div>
                  <Button color="primary" variant="flat" startContent={<FontAwesomeIcon icon={faPlus} />} onPress={() => setEditing({ label: '', url: '' })}>
                    {t('actions.add')}
                  </Button>
                </div>
              </Card>
            </motion.div>
          ) : (
            <motion.div key="list" {...listItem} layout>
              <Card shadow="sm" className="border border-default-100">
                <AnimatePresence initial={false}>
                  {state.profiles.map((profile, index) => {
                    const connection = state.connections[profile.id];
                    const issue = connection && (connection.phase === 'failed' || connection.phase === 'needs-trust') ? connection : null;
                    const subtitle = `${displayHost(profile.url)} · ${profile.lastIdentity
                      ? t('meta.version', { version: profile.lastIdentity.hostVersion })
                      : t('meta.neverConnected')}`;
                    return (
                      <motion.div key={profile.id} layout {...listItem}>
                        {index > 0 && <Divider />}
                        <StationRow
                          icon={faTowerBroadcast}
                          title={profile.label}
                          subtitle={subtitle}
                          monospaceSubtitle={false}
                          isOpen={state.openStationIds.includes(profile.id)}
                          isLastUsed={state.activeStationId === profile.id}
                          pinned={Boolean(profile.pinnedFingerprint256)}
                          busy={busyId === profile.id}
                          onOpen={() => open(profile.id)}
                          onEdit={() => setEditing({ id: profile.id, label: profile.label, url: profile.url })}
                          onRemove={() => setRemoving(profile)}
                        >
                          {issue && (
                            <Alert
                              color={issue.phase === 'needs-trust' ? 'warning' : 'danger'}
                              variant="flat"
                              title={issue.phase === 'needs-trust'
                                ? t('cert.untrustedTitle')
                                : issue.error?.kind === 'certificate-changed' ? t('cert.changedTitle') : t('connect.failedTitle')}
                              description={issue.phase === 'needs-trust' ? t('cert.untrustedBody') : describeConnectError(t, issue.error)}
                            />
                          )}
                        </StationRow>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {state.discovered.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="px-1">
            <h2 className="text-tiny font-semibold uppercase tracking-wide text-default-500">{t('discovered.title')}</h2>
            <p className="mt-0.5 text-tiny text-default-400">{t('discovered.description')}</p>
          </div>
          <Card shadow="sm" className="border border-default-100">
            {state.discovered.map((station, index) => (
              <React.Fragment key={station.instanceId}>
                {index > 0 && <Divider />}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-medium bg-default-100 text-default-500">
                    <FontAwesomeIcon icon={faTowerBroadcast} className="text-small" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-small font-semibold text-foreground">{station.label}</p>
                    <p className="truncate font-mono text-tiny text-default-500">{displayHost(station.url)}</p>
                  </div>
                  {station.profileId ? (
                    <Button size="sm" color="primary" variant="flat" onPress={() => open(station.profileId!)}>{t('actions.open')}</Button>
                  ) : (
                    <Button size="sm" variant="flat" startContent={<FontAwesomeIcon icon={faPlus} />} onPress={() => setEditing({ label: station.label, url: station.url })}>
                      {t('discovered.add')}
                    </Button>
                  )}
                </div>
              </React.Fragment>
            ))}
          </Card>
        </section>
      )}

      <StationEditorModal isOpen={editing !== null} initial={editing} onClose={() => setEditing(null)} />

      <Modal isOpen={removing !== null} onClose={() => setRemoving(null)} placement="center" backdrop="blur" size="sm">
        <ModalContent>
          {(close) => (
            <>
              <ModalHeader>{t('remove.title')}</ModalHeader>
              <ModalBody>
                <p className="text-small text-default-600">{t('remove.body', { label: removing?.label ?? '' })}</p>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={close}>{t('actions.cancel')}</Button>
                <Button
                  color="danger"
                  isLoading={removing !== null && busyId === removing.id}
                  onPress={() => {
                    const target = removing;
                    if (!target) return;
                    void run(target.id, () => removeStation(target.id)).then(() => setRemoving(null));
                  }}
                >
                  {t('remove.confirm')}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
};

/** Station manager and remote connection page of the desktop shell. */
export const StationManagerPage: React.FC = () => {
  useTheme();
  const { t } = useTranslation('stations');
  const state = useDesktopStations();
  const params = new URLSearchParams(window.location.search);
  const connectStationId = params.get('mode') === 'connect' ? params.get('station') : null;

  React.useEffect(() => {
    document.title = `TX-5DR · ${t('title')}`;
  }, [t]);

  return (
    // The document itself never scrolls (index.css); the content area below the
    // title bar does, so the drag region stays put.
    <div className="app-viewport-height flex flex-col bg-default-50 text-foreground dark:bg-background">
      <TitlebarDragRegion />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <main
          className={`mx-auto flex w-full max-w-[680px] flex-1 flex-col px-6 pb-10 ${connectStationId ? 'items-center justify-center pb-[12vh]' : 'pt-2'}`}
        >
          {!state ? (
            <div className="flex flex-1 items-center justify-center"><Spinner /></div>
          ) : connectStationId ? (
            <ConnectView state={state} stationId={connectStationId} />
          ) : (
            <ManageView state={state} />
          )}
        </main>
      </div>
    </div>
  );
};
