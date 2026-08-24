import React, { useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownload, faRotate, faTrash } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import { UserRole, type ImageArtifact } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { useImageRadio } from '../../hooks/useImageRadio';
import { useHasMinRole } from '../../store/authStore';

function artifactFileName(artifact: ImageArtifact): string {
  const timestamp = new Date(artifact.createdAt).toISOString().replace(/[:.]/g, '-');
  const mode = artifact.codecMode.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `tx5dr-${artifact.family}-${mode}-${timestamp}.png`;
}

async function downloadBlob(blob: Blob, fileName: string, title: string): Promise<void> {
  const electronSaveFile = window.electronAPI?.fs?.saveFile;
  if (electronSaveFile) {
    await electronSaveFile({
      title,
      defaultName: fileName,
      filters: [{ name: 'PNG', extensions: ['png'] }],
      data: new Uint8Array(await blob.arrayBuffer()),
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ArtifactThumb({
  artifact, canDelete, downloading, deleting, onDownload, onDelete,
}: {
  artifact: ImageArtifact; canDelete: boolean; downloading: boolean; deleting: boolean;
  onDownload: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation('image');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void api.getImageArtifactBlob(artifact.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.id]);
  return (
    <div className="group relative aspect-[4/3] overflow-hidden rounded-md bg-black">
      <button type="button" className="h-full w-full" onClick={() => url && window.open(url, '_blank')} aria-label={t('openRecord')}>
        {url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <span className="block h-full w-full animate-pulse bg-default-100" />}
      </button>
      <div className="absolute right-1 top-1 flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <Button isIconOnly size="sm" variant="flat" className="h-7 w-7 min-w-7 bg-black/70 text-white backdrop-blur" isLoading={downloading} onPress={onDownload} aria-label={t('downloadRecord')} title={t('downloadRecord')}>
          <FontAwesomeIcon icon={faDownload} className="text-[11px]" />
        </Button>
        {canDelete ? (
          <Button isIconOnly size="sm" variant="flat" color="danger" className="h-7 w-7 min-w-7 bg-black/70 text-danger-300 backdrop-blur" isLoading={deleting} onPress={onDelete} aria-label={t('deleteRecord')} title={t('deleteRecord')}>
            <FontAwesomeIcon icon={faTrash} className="text-[11px]" />
          </Button>
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/70 px-2 py-1 text-[11px] text-white">
        <span className="truncate font-mono">{artifact.codecMode}</span>
        <span className="shrink-0 text-white/65">{new Date(artifact.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  );
}

export function ImageArtifactGallery() {
  const { t } = useTranslation('image');
  const canDelete = useHasMinRole(UserRole.OPERATOR);
  const { artifacts, refreshArtifacts } = useImageRadio();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deleteArtifact, setDeleteArtifact] = useState<ImageArtifact | null>(null);
  const [deleting, setDeleting] = useState(false);

  const download = async (artifact: ImageArtifact) => {
    setDownloadingId(artifact.id);
    try {
      await downloadBlob(await api.getImageArtifactBlob(artifact.id), artifactFileName(artifact), t('downloadRecord'));
    } catch {
      addToast({ title: t('recordDownloadFailed'), color: 'danger' });
    } finally {
      setDownloadingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteArtifact) return;
    setDeleting(true);
    try {
      await api.deleteImageArtifact(deleteArtifact.id);
      setDeleteArtifact(null);
      await refreshArtifacts();
    } catch {
      addToast({ title: t('recordDeleteFailed'), color: 'danger' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex items-center justify-end">
          <Button isIconOnly size="sm" variant="light" onPress={() => void refreshArtifacts()} aria-label={t('refresh')}>
            <FontAwesomeIcon icon={faRotate} />
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto md:grid-cols-3">
          {artifacts.map((artifact) => (
            <ArtifactThumb
              key={artifact.id} artifact={artifact} canDelete={canDelete}
              downloading={downloadingId === artifact.id}
              deleting={deleting && deleteArtifact?.id === artifact.id}
              onDownload={() => void download(artifact)} onDelete={() => setDeleteArtifact(artifact)}
            />
          ))}
        </div>
      </div>

      <Modal isOpen={Boolean(deleteArtifact)} onClose={() => { if (!deleting) setDeleteArtifact(null); }} size="sm" placement="center">
        <ModalContent>
          <ModalHeader>{t('deleteRecord')}</ModalHeader>
          <ModalBody><p className="text-sm text-default-600">{t('deleteRecordConfirm')}</p></ModalBody>
          <ModalFooter>
            <Button variant="flat" isDisabled={deleting} onPress={() => setDeleteArtifact(null)}>{t('common:button.cancel')}</Button>
            <Button color="danger" isLoading={deleting} onPress={() => void confirmDelete()}>{t('common:button.delete')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
