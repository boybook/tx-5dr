import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLink, faTag } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { DesktopStationProbeResult } from '@tx5dr/contracts';
import { describeBridgeError, probeStationAddress, saveStation } from '../../utils/desktopStations';
import { CertificateDetails } from './CertificateDetails';
import { describeProbeFailure } from './stationText';

export interface StationEditorValue {
  id?: string;
  label: string;
  url: string;
}

interface StationEditorModalProps {
  isOpen: boolean;
  initial: StationEditorValue | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}

const reveal = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] as const },
};

export const StationEditorModal: React.FC<StationEditorModalProps> = ({ isOpen, initial, onClose, onSaved }) => {
  const { t } = useTranslation('stations');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [probe, setProbe] = useState<DesktopStationProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLabel(initial?.label ?? '');
    setUrl(initial?.url ?? '');
    setProbe(null);
    setTrust(false);
    setError(null);
  }, [isOpen, initial]);

  const runProbe = async () => {
    setProbing(true);
    setError(null);
    try {
      setProbe(await probeStationAddress(url));
      setTrust(false);
    } catch (probeError) {
      setError(describeBridgeError(probeError));
    } finally {
      setProbing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const trustFingerprint256 = trust && probe?.kind === 'certificate-untrusted' ? probe.certificate.fingerprint256 : null;
      const id = await saveStation({ id: initial?.id, label, url, trustFingerprint256 });
      onSaved?.(id);
      onClose();
    } catch (saveError) {
      const message = describeBridgeError(saveError);
      setError(message.startsWith('invalid_station_url') ? t('errors.invalidUrl') : t('errors.unknown', { message }));
    } finally {
      setSaving(false);
    }
  };

  const urlInvalid = probe?.kind === 'invalid-url';
  const probeFailure = probe && probe.kind !== 'ok' && probe.kind !== 'certificate-untrusted' && probe.kind !== 'invalid-url'
    ? describeProbeFailure(t, probe)
    : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="center" backdrop="blur" size="lg" scrollBehavior="inside">
      <ModalContent>
        {() => (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <ModalHeader className="flex flex-col gap-1">
              {initial?.id ? t('editor.editTitle') : t('editor.addTitle')}
            </ModalHeader>
            <ModalBody className="gap-5">
              <Input
                autoFocus={!initial?.id}
                label={t('editor.label')}
                labelPlacement="outside"
                placeholder={t('editor.labelPlaceholder')}
                variant="bordered"
                value={label}
                maxLength={80}
                onValueChange={setLabel}
                startContent={<FontAwesomeIcon icon={faTag} className="text-small text-default-400" />}
              />
              <div className="flex items-end gap-2">
                <Input
                  isRequired
                  label={t('editor.url')}
                  labelPlacement="outside"
                  placeholder={t('editor.urlPlaceholder')}
                  description={t('editor.urlDescription')}
                  variant="bordered"
                  value={url}
                  spellCheck="false"
                  autoCapitalize="off"
                  autoCorrect="off"
                  isInvalid={urlInvalid}
                  errorMessage={urlInvalid ? t('errors.invalidUrl') : undefined}
                  onValueChange={(next) => {
                    setUrl(next);
                    setProbe(null);
                    setTrust(false);
                  }}
                  startContent={<FontAwesomeIcon icon={faLink} className="text-small text-default-400" />}
                  classNames={{ input: 'font-mono text-small' }}
                />
                <Button
                  variant="flat"
                  className="mb-6 flex-shrink-0"
                  isLoading={probing}
                  isDisabled={!url.trim()}
                  onPress={() => void runProbe()}
                >
                  {t('actions.test')}
                </Button>
              </div>

              <AnimatePresence initial={false}>
                {probe?.kind === 'ok' && (
                  <motion.div key="ok" {...reveal} className="overflow-hidden">
                    <Alert
                      color="success"
                      variant="flat"
                      title={t('probe.okTitle')}
                      description={t('probe.okDescription', { version: probe.identity.hostVersion })}
                    />
                  </motion.div>
                )}
                {probe?.kind === 'certificate-untrusted' && (
                  <motion.div key="cert" {...reveal} className="overflow-hidden">
                    <div className="flex flex-col gap-4">
                      <Alert color="warning" variant="flat" title={t('cert.untrustedTitle')} description={t('cert.untrustedBody')} />
                      <CertificateDetails fingerprint256={probe.certificate.fingerprint256} certificate={probe.certificate} />
                      <Checkbox size="sm" color="warning" isSelected={trust} onValueChange={setTrust}>
                        <span className="text-small">{t('editor.trust')}</span>
                      </Checkbox>
                    </div>
                  </motion.div>
                )}
                {probeFailure && (
                  <motion.div key="failure" {...reveal} className="overflow-hidden">
                    <Alert color="danger" variant="flat" description={probeFailure} />
                  </motion.div>
                )}
                {error && (
                  <motion.div key="error" {...reveal} className="overflow-hidden">
                    <Alert color="danger" variant="flat" description={error} />
                  </motion.div>
                )}
              </AnimatePresence>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>{t('actions.cancel')}</Button>
              <Button color="primary" type="submit" isLoading={saving} isDisabled={!url.trim()}>
                {t('actions.save')}
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
};
