import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, SelectItem, Spinner, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownload, faFolderOpen, faRotate, faTrash } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { useTranslation } from 'react-i18next';
import { api } from '@tx5dr/core';

type Settings = { format: 'wav' | 'mp3'; sampleRate: 16000 | 24000 | 44100 | 48000; bitDepth: 16 | 24 | 32; source: 'rx' | 'tx' | 'both'; directory: string };
type Entry = { id: string; fileName: string; format: 'wav' | 'mp3'; source: 'rx' | 'tx' | 'both'; startedAt: number; durationMs: number; sizeBytes: number };
const QUALITY_OPTIONS = [
  { key: '16000-16', sampleRate: 16000 as const, bitDepth: 16 as const },
  { key: '16000-24', sampleRate: 16000 as const, bitDepth: 24 as const },
  { key: '16000-32', sampleRate: 16000 as const, bitDepth: 32 as const },
  { key: '24000-16', sampleRate: 24000 as const, bitDepth: 16 as const },
  { key: '24000-24', sampleRate: 24000 as const, bitDepth: 24 as const },
  { key: '24000-32', sampleRate: 24000 as const, bitDepth: 32 as const },
  { key: '44100-16', sampleRate: 44100 as const, bitDepth: 16 as const },
  { key: '44100-24', sampleRate: 44100 as const, bitDepth: 24 as const },
  { key: '44100-32', sampleRate: 44100 as const, bitDepth: 32 as const },
  { key: '48000-16', sampleRate: 48000 as const, bitDepth: 16 as const },
  { key: '48000-24', sampleRate: 48000 as const, bitDepth: 24 as const },
  { key: '48000-32', sampleRate: 48000 as const, bitDepth: 32 as const },
];
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function RecordingSettings(): React.ReactElement {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const refreshEntries = useCallback(async () => { setLoadingEntries(true); try { setEntries(await api.getRecordings() as Entry[]); } catch (error) { addToast({ title: error instanceof Error ? error.message : t('recording.loadFailed'), color: 'danger' }); } finally { setLoadingEntries(false); } }, [t]);
  useEffect(() => { void Promise.all([api.getRecordingSettings(), api.getRecordings()]).then(([next, list]) => { setSettings(next as Settings); setEntries(list as Entry[]); }).catch((error: unknown) => addToast({ title: error instanceof Error ? error.message : t('recording.loadFailed'), color: 'danger' })); }, [t]);
  if (!settings) return <Spinner size="sm" />;
  const save = async () => { setBusy(true); try { await api.updateRecordingSettings(settings); addToast({ title: t('recording.saveSuccess'), color: 'success' }); } catch (error) { addToast({ title: error instanceof Error ? error.message : t('recording.saveFailed'), color: 'danger' }); } finally { setBusy(false); } };
  const chooseDirectory = async () => { const selected = await window.electronAPI?.fs?.selectDirectory({ title: t('recording.chooseDirectory') }); if (selected) setSettings(current => current ? { ...current, directory: selected } : current); };
  const download = async (entry: Entry) => { try { const blob = await api.downloadRecording(entry.id); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = entry.fileName; anchor.click(); URL.revokeObjectURL(url); } catch (error) { addToast({ title: error instanceof Error ? error.message : t('recording.downloadFailed'), color: 'danger' }); } };
  const remove = async (entry: Entry) => { try { await api.deleteRecording(entry.id); setEntries(current => current.filter(item => item.id !== entry.id)); } catch (error) { addToast({ title: error instanceof Error ? error.message : t('recording.deleteFailed'), color: 'danger' }); } };
  const sourceKey = (source: Entry['source']) => source === 'rx' ? 'sourceRx' : source === 'tx' ? 'sourceTx' : 'sourceBoth';
  const qualityKey = `${settings.sampleRate}-${settings.bitDepth}`;
  const qualityOption = QUALITY_OPTIONS.find(option => option.key === qualityKey);
  const qualityLabel = qualityOption ? `${qualityOption.bitDepth} bit / ${qualityOption.sampleRate} Hz` : qualityKey;
  const selectQuality = (key: string) => { const option = QUALITY_OPTIONS.find(item => item.key === key); if (option) setSettings({ ...settings, sampleRate: option.sampleRate, bitDepth: option.bitDepth }); };
  return <div className="space-y-6">
    <div className="space-y-4"><h3 className="text-lg font-semibold">{t('recording.title')}</h3><p className="text-sm text-default-500">{t('recording.description')}</p><div className="flex flex-col gap-4"><Select label={t('recording.format')} selectedKeys={new Set([settings.format])} onSelectionChange={keys => setSettings({ ...settings, format: String(Array.from(keys)[0]) as Settings['format'] })}><SelectItem key="wav" textValue="WAV">WAV</SelectItem><SelectItem key="mp3" textValue="MP3">MP3</SelectItem></Select><Select label={t('recording.quality')} selectedKeys={new Set([qualityKey])} renderValue={() => qualityLabel} onSelectionChange={keys => selectQuality(String(Array.from(keys)[0]))}>{QUALITY_OPTIONS.map(option => { const label = `${option.bitDepth} bit / ${option.sampleRate} Hz`; return <SelectItem key={option.key} textValue={label}>{label}</SelectItem>; })}</Select><Select label={t('recording.source')} selectedKeys={new Set([settings.source])} onSelectionChange={keys => setSettings({ ...settings, source: String(Array.from(keys)[0]) as Settings['source'] })}><SelectItem key="rx" textValue={t('recording.sourceRx')}>{t('recording.sourceRx')}</SelectItem><SelectItem key="tx" textValue={t('recording.sourceTx')}>{t('recording.sourceTx')}</SelectItem><SelectItem key="both" textValue={t('recording.sourceBoth')}>{t('recording.sourceBoth')}</SelectItem></Select></div><div className="flex items-end gap-2"><Input className="flex-1" label={t('recording.directory')} value={settings.directory} onValueChange={directory => setSettings({ ...settings, directory })} /><Tooltip content={t('recording.chooseDirectory')}><Button isIconOnly aria-label={t('recording.chooseDirectory')} variant="flat" onPress={() => { void chooseDirectory(); }}><FontAwesomeIcon icon={faFolderOpen} /></Button></Tooltip></div><Button color="primary" isLoading={busy} onPress={() => { void save(); }}>{t('recording.save')}</Button></div>
    <div className="space-y-3"><div className="flex items-center justify-between"><h3 className="text-lg font-semibold">{t('recording.listTitle')}</h3><Tooltip content={t('recording.refresh')}><Button isIconOnly aria-label={t('recording.refresh')} variant="light" isLoading={loadingEntries} onPress={() => { void refreshEntries(); }}><FontAwesomeIcon icon={faRotate} /></Button></Tooltip></div>{entries.length === 0 ? <p className="text-sm text-default-500">{t('recording.empty')}</p> : entries.map(entry => <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-medium border border-divider p-3"><div className="min-w-0"><p className="truncate font-medium">{entry.fileName}</p><p className="text-xs text-default-500">{new Date(entry.startedAt).toLocaleString()} · {entry.format.toUpperCase()} · {t(`recording.${sourceKey(entry.source)}`)} · {(entry.durationMs / 1000).toFixed(1)}s · {formatBytes(entry.sizeBytes)}</p></div><div className="flex gap-1"><Tooltip content={t('recording.download')}><Button isIconOnly aria-label={t('recording.download')} size="sm" variant="light" onPress={() => { void download(entry); }}><FontAwesomeIcon icon={faDownload} /></Button></Tooltip><Tooltip content={t('recording.delete')}><Button isIconOnly aria-label={t('recording.delete')} size="sm" variant="light" color="danger" onPress={() => { void remove(entry); }}><FontAwesomeIcon icon={faTrash} /></Button></Tooltip></div></div>)}</div>
  </div>;
}
