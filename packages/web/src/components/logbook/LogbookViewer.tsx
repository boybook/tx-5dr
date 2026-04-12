import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Button,
  Input,
  Chip,
  Pagination,
  Spinner,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Alert,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Tooltip,
} from '@heroui/react';
import QSOFormModal from './QSOFormModal';
import { SearchIcon } from '@heroui/shared-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faSync, faDownload, faUpload, faExternalLinkAlt, faEdit, faTrash, faFolderOpen, faCog, faPlus, faTableCells } from '@fortawesome/free-solid-svg-icons';
import type { QSORecord, LogBookStatistics, CreateQSORequest, LogBookImportResult } from '@tx5dr/contracts';
import { api, WSClient, ApiError } from '@tx5dr/core';
import { getLogbookWebSocketUrl } from '../../utils/config';
import { isElectron } from '../../utils/config';
import { showErrorToast } from '../../utils/errorToast';
import { SyncConfigModal } from './SyncConfigModal';
import { PluginIframeHost } from '../plugins/PluginIframeHost';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import RecentQSOGlobeCard from './RecentQSOGlobeCard';
import { getAuthHeaders, getStoredJwt } from '../../utils/authHeaders';

const logger = createLogger('LogbookViewer');

// ElectronAPI 类型定义
interface ElectronAPI {
  shell?: {
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<string>;
  };
  config?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(key: string): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set(key: string, value: any): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAll(): Promise<Record<string, any>>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

interface LogbookViewerProps {
  operatorId: string;
  logBookId?: string;
  operatorCallsign?: string;
}

interface QSOFilters {
  callsign?: string;
  grid?: string;
  band?: string;
  mode?: string;
  startDate?: string;
  endDate?: string;
  qslStatus?: 'none' | 'confirmed' | 'uploaded';
  dxccStatus?: 'deleted';
  qslFlow?: 'two_way_confirmed' | 'not_two_way_confirmed';
}

type DxccViewMode = 'mixed' | 'band' | 'mode';

function normalizeGridFilterValue(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '').slice(0, 8);
}

const LogbookViewer: React.FC<LogbookViewerProps> = ({ operatorId, logBookId, operatorCallsign }) => {
  const { t } = useTranslation('logbook');
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [qsos, setQsos] = useState<QSORecord[]>([]);
  const [statistics, setStatistics] = useState<LogBookStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<QSOFilters>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState<number>(50);
  const [totalRecords, setTotalRecords] = useState(0);
  const [actualTotalRecords, setActualTotalRecords] = useState(0);
  const [hasFilters, setHasFilters] = useState(false);
  const [sortDescriptor, setSortDescriptor] = useState<{
    column: string;
    direction: 'ascending' | 'descending';
  }>({ column: 'startTime', direction: 'descending' });
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [isGridSearchExpanded, setIsGridSearchExpanded] = useState(false);
  const [dxccViewMode, setDxccViewMode] = useState<DxccViewMode>('mixed');

  // 编辑 Modal 状态
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingQSO, setEditingQSO] = useState<QSORecord | null>(null);
  const [editFormData, setEditFormData] = useState<Partial<QSORecord>>({});
  const [isEditSaving, setIsEditSaving] = useState(false);

  // 删除确认 Modal 状态
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deletingQSO, setDeletingQSO] = useState<QSORecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // 补录 Modal 状态
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addFormData, setAddFormData] = useState<Partial<QSORecord>>({
    callsign: '',
    mode: 'FT8',
    messages: [],
  });
  const [isAddSaving, setIsAddSaving] = useState(false);

  // 获取操作员连接的日志本
  // 日志本ID就是呼号，如果没有指定则使用操作员ID作为后备
  const effectiveLogBookId = logBookId || operatorId;

  // 日志本专用WebSocket：只接收轻量通知，然后主动刷新
  useEffect(() => {
    // 仅按 operatorId 订阅，避免 logBookId 不一致导致过滤失败
    // 浏览器 WebSocket 不支持自定义请求头，通过 token 参数传递 JWT
    const wsJwt = getStoredJwt() || undefined;
    const url = getLogbookWebSocketUrl({ operatorId, token: wsJwt });
    const client = new WSClient({ url, heartbeatInterval: 30000 });

    const refresh = () => {
      refreshLogbookData().catch(() => {});
    };

    // 类型断言：logbookChangeNotice 是日志本专用事件
    const handleLogbookChange = (payload: unknown) => {
      const data = payload as { logBookId?: string; operatorId?: string };
      if (!data) return;
      // 以 operatorId 为主进行匹配；其次尝试 logBookId
      if (data.operatorId === operatorId || (data.logBookId && data.logBookId === effectiveLogBookId)) {
        logger.debug('Received logbook change notification, refreshing data');
        refresh();
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.onWSEvent('logbookChangeNotice' as any, handleLogbookChange);
    client.connect().catch(() => {});

    return () => {
      client.disconnect();
    };
  }, [operatorId, effectiveLogBookId]);

  // 加载QSO记录
  const loadQSOs = async () => {
    try {
      setLoading(true);
      setError(null);
      const queryOptions = {
        ...filters,
        limit: itemsPerPage,
        offset: (currentPage - 1) * itemsPerPage,
      };

      const response = await api.getLogBookQSOs(effectiveLogBookId, queryOptions);
      setQsos(response.data);
      // 使用筛选后的总数来计算分页
      setTotalRecords(response.meta?.total || response.data.length);
      // 保存实际总记录数用于显示
      setActualTotalRecords(response.meta?.totalRecords || response.data.length);
      setHasFilters(response.meta?.hasFilters || false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('error.loadQSOFailed');
      logger.error('Failed to load QSO records:', error);
      setError(errorMessage);
      setQsos([]); // 清空数据
    } finally {
      setLoading(false);
    }
  };

  // 加载统计信息
  const loadStatistics = async () => {
    try {
      const response = await api.getLogBook(effectiveLogBookId);
      setStatistics(response.data.statistics);
    } catch (error) {
      logger.error('Failed to load statistics:', error);
      // 统计信息加载失败不影响QSO记录的显示
      setStatistics(null);
    }
  };

  const refreshLogbookData = async () => {
    await loadQSOs();
    await loadStatistics();
  };

  // 初始加载与筛选/分页变化时加载
  useEffect(() => {
    loadQSOs();
    loadStatistics();
  }, [effectiveLogBookId, filters, currentPage, itemsPerPage]);

  // 加载呼号的同步配置���要
  useEffect(() => {
    if (operatorCallsign) {
      refreshSyncProviders(operatorCallsign).catch(() => {});
    }
  }, [operatorCallsign]);

  // 总页数计算 - 基于筛选后的记录数
  const totalPages = useMemo(() => {
    const pages = Math.ceil(totalRecords / itemsPerPage);
    return pages || 1;
  }, [totalRecords, itemsPerPage]);

  const handleItemsPerPageChange = (nextPageSize: number) => {
    if (!PAGE_SIZE_OPTIONS.includes(nextPageSize as typeof PAGE_SIZE_OPTIONS[number]) || nextPageSize === itemsPerPage) {
      return;
    }

    setItemsPerPage(nextPageSize);
    setCurrentPage(1);
  };

  const dxccBucketItems = useMemo(() => {
    if (!statistics?.dxcc) {
      return [];
    }

    const source = dxccViewMode === 'band' ? statistics.dxcc.byBand : statistics.dxcc.byMode;
    return [...source]
      .sort((left, right) => {
        if (right.worked !== left.worked) {
          return right.worked - left.worked;
        }
        if (right.confirmed !== left.confirmed) {
          return right.confirmed - left.confirmed;
        }
        return left.key.localeCompare(right.key);
      })
      .slice(0, 6);
  }, [dxccViewMode, statistics]);

  // 导出功能（增强错误处理）
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportGuideOpen, setIsImportGuideOpen] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Plugin-based sync providers (dynamic)
  interface SyncAction {
    id: string;
    label: string;
    description?: string;
    icon?: 'download' | 'upload' | 'sync';
    pageId?: string;
    operation?: 'upload' | 'download' | 'full_sync';
  }
  interface SyncProviderInfo {
    id: string;
    pluginName: string;
    displayName: string;
    color?: string;
    settingsPageId: string;
    actions?: SyncAction[];
  }
  interface SyncPreflightIssue {
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
  }
  interface SyncUploadPreflightResult {
    ready: boolean;
    pendingCount: number;
    uploadableCount: number;
    blockedCount: number;
    issues?: SyncPreflightIssue[];
    guidance?: string[];
  }
  const [syncProviders, setSyncProviders] = useState<SyncProviderInfo[]>([]);
  const [syncConfigured, setSyncConfigured] = useState<Record<string, boolean>>({});
  const [syncingProviders, setSyncingProviders] = useState<Record<string, boolean>>({});
  const [syncMessages, setSyncMessages] = useState<Record<string, { type: 'success' | 'error'; text: string }>>({});

  // 同步配置
  const [isSyncConfigOpen, setIsSyncConfigOpen] = useState(false);
  const [syncConfigInitialTab, setSyncConfigInitialTab] = useState<string>('wavelog');

  // Sync action iframe modal (for actions with pageId)
  const [actionModal, setActionModal] = useState<{
    pluginName: string;
    pageId: string;
    title: string;
  } | null>(null);

  const refreshSyncProviders = async (callsign: string) => {
    try {
      const [providers, configuredRes] = await Promise.all([
        fetch('/api/plugins/sync-providers', { headers: getAuthHeaders() }).then(r => r.json()) as Promise<SyncProviderInfo[]>,
        fetch(`/api/plugins/sync-providers/configured?callsign=${encodeURIComponent(callsign)}`, {
          headers: getAuthHeaders(),
        }).then(r => r.json()) as Promise<{ providers: Record<string, boolean> }>,
      ]);
      setSyncProviders(providers);
      setSyncConfigured(configuredRes.providers ?? {});
    } catch (err) {
      logger.warn('Failed to load sync providers', err);
    }
  };

  const openSyncConfig = (tab: string = 'wavelog') => {
    setSyncConfigInitialTab(tab);
    setIsSyncConfigOpen(true);
  };

  const handleExport = async (format: 'adif' | 'csv') => {
    if (isExporting) return;

    try {
      setIsExporting(true);
      setExportError(null);

      const exportData = await api.exportLogBook(effectiveLogBookId, {
        format,
        ...filters,
      });

      const blob = new Blob([exportData], {
        type: format === 'adif' ? 'text/plain' : 'text/csv'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logbook_${operatorId}_${new Date().toISOString().split('T')[0]}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      logger.debug(`Successfully exported ${format.toUpperCase()} format log`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('error.exportFailed');
      logger.error('Export failed:', error);
      setExportError(errorMessage);
    } finally {
      setIsExporting(false);
    }
  };

  const buildImportSuccessMessage = (result: LogBookImportResult) => {
    const formatLabel = result.detectedFormat === 'csv'
      ? t('import.csv')
      : t('import.adif');

    return t('import.summary', {
      format: formatLabel,
      totalRead: result.totalRead,
      imported: result.imported,
      merged: result.merged,
      skipped: result.skipped,
    });
  };

  const triggerImportPicker = () => {
    if (isImporting) {
      return;
    }
    setIsImportGuideOpen(true);
  };

  const handleImportGuideConfirm = () => {
    setIsImportGuideOpen(false);
    importFileInputRef.current?.click();
  };

  const handleImportFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file || isImporting) {
      return;
    }

    try {
      setIsImporting(true);
      setImportError(null);
      setImportSuccess(null);

      const result = await api.importLogBookFile(effectiveLogBookId, file);
      const successMessage = buildImportSuccessMessage(result.data);
      setImportSuccess(successMessage);

      await refreshLogbookData();

      logger.info('Logbook import completed', {
        logBookId: effectiveLogBookId,
        detectedFormat: result.data.detectedFormat,
        imported: result.data.imported,
        merged: result.data.merged,
        skipped: result.data.skipped,
      });
    } catch (error) {
      logger.error('Logbook import failed:', error);
      if (error instanceof ApiError) {
        setImportError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code,
        });
      } else {
        setImportError(error instanceof Error ? error.message : t('import.errorFallback'));
      }
    } finally {
      setIsImporting(false);
    }
  };

  // Plugin-based sync provider handler (generic for all providers)
  const handleProviderSync = async (providerId: string, operation: 'download' | 'upload' | 'full_sync') => {
    if (syncingProviders[providerId]) return;
    const provider = syncProviders.find(p => p.id === providerId);
    const name = provider?.displayName ?? providerId;

    setSyncingProviders(prev => ({ ...prev, [providerId]: true }));
    setSyncMessages(prev => { const next = { ...prev }; delete next[providerId]; return next; });

    // Format upload result: "uploaded 3, skipped 1, failed 0"
    const fmtUpload = (res: Record<string, unknown>): string => {
      const parts: string[] = [];
      if (res.uploaded) parts.push(t('sync.provider.resultUploaded', { count: res.uploaded }));
      if (res.skipped) parts.push(t('sync.provider.resultSkipped', { count: res.skipped }));
      if (res.failed) parts.push(t('sync.provider.resultFailed', { count: res.failed }));
      if (parts.length === 0) parts.push(t('sync.provider.resultUploaded', { count: 0 }));
      return parts.join(t('sync.provider.resultSeparator'));
    };

    // Format download result: "downloaded 5, matched 3, updated 2"
    const fmtDownload = (res: Record<string, unknown>): string => {
      const parts: string[] = [];
      if (res.downloaded) parts.push(t('sync.provider.resultDownloaded', { count: res.downloaded }));
      if (res.matched) parts.push(t('sync.provider.resultMatched', { count: res.matched }));
      if (res.updated) parts.push(t('sync.provider.resultUpdated', { count: res.updated }));
      if (parts.length === 0) parts.push(t('sync.provider.resultDownloaded', { count: 0 }));
      return parts.join(t('sync.provider.resultSeparator'));
    };

    const fmtErrors = (errors?: string[]): string => {
      if (!errors || errors.length === 0) return '';
      return '\n' + errors.join('\n');
    };

    const fmtPreflight = (result: SyncUploadPreflightResult): string => {
      const lines = [
        t('sync.provider.preflightSummary', {
          pending: result.pendingCount,
          uploadable: result.uploadableCount,
          blocked: result.blockedCount,
        }),
      ];
      if (result.issues?.length) {
        lines.push(...result.issues.map((issue) => issue.message));
      }
      return lines.join('\n');
    };

    try {
      const callsign = operatorCallsign || '';
      const base = `/api/plugins/sync-providers/${encodeURIComponent(providerId)}`;

      const doPost = async <T,>(endpoint: string, body: unknown): Promise<T> => {
        const response = await fetch(`${base}/${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: JSON.stringify(body),
        });
        const json = await response.json().catch(() => null) as T | { error?: string } | null;
        if (!response.ok) {
          const message = json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
            ? json.error
            : t('sync.provider.syncError', { name });
          throw new Error(message);
        }
        return json as T;
      };

      if (operation !== 'download') {
        const preflight = await doPost<SyncUploadPreflightResult | null>('upload-preflight', { callsign });
        if (preflight && !preflight.ready) {
          setSyncMessages(prev => ({
            ...prev,
            [providerId]: { type: 'error', text: fmtPreflight(preflight) },
          }));
          return;
        }
      }

      if (operation === 'full_sync') {
        const dlRes = await doPost<Record<string, unknown>>('download', { callsign });
        const ulRes = await doPost<Record<string, unknown>>('upload', { callsign });
        const hasFailure = (dlRes.errors as string[] | undefined)?.length || (ulRes.errors as string[] | undefined)?.length || (ulRes.failed as number) > 0;
        const summary = `↓ ${fmtDownload(dlRes)}  ↑ ${fmtUpload(ulRes)}` + fmtErrors([...(dlRes.errors as string[] ?? []), ...(ulRes.errors as string[] ?? [])]);
        setSyncMessages(prev => ({
          ...prev,
          [providerId]: { type: hasFailure ? 'error' : 'success', text: summary },
        }));
        await refreshLogbookData();
      } else if (operation === 'download') {
        const res = await doPost<Record<string, unknown>>('download', { callsign });
        const text = fmtDownload(res) + fmtErrors(res.errors as string[] | undefined);
        setSyncMessages(prev => ({ ...prev, [providerId]: { type: (res.errors as string[])?.length ? 'error' : 'success', text } }));
        await refreshLogbookData();
      } else {
        const res = await doPost<Record<string, unknown>>('upload', { callsign });
        const hasFailure = (res.failed as number) > 0 || (res.errors as string[] | undefined)?.length;
        const text = fmtUpload(res) + fmtErrors(res.errors as string[] | undefined);
        setSyncMessages(prev => ({ ...prev, [providerId]: { type: hasFailure ? 'error' : 'success', text } }));
        await refreshLogbookData();
      }
    } catch (error) {
      logger.error(`Sync failed: provider=${providerId}`, error);
      const msg = error instanceof Error ? error.message : t('sync.provider.syncError', { name });
      setSyncMessages(prev => ({ ...prev, [providerId]: { type: 'error', text: msg } }));
    } finally {
      setSyncingProviders(prev => ({ ...prev, [providerId]: false }));
      setTimeout(() => {
        setSyncMessages(prev => {
          if (prev[providerId]?.type === 'success') {
            const next = { ...prev }; delete next[providerId]; return next;
          }
          return prev;
        });
      }, 8000);
    }
  };


  // 打开日志文件目录（仅Electron）
  const handleOpenDataDir = async () => {
    try {
      const result = await api.getLogbookDataPath();
      if (isElectron() && window.electronAPI?.shell?.openPath) {
        await window.electronAPI.shell.openPath(result.path);
      }
    } catch (error) {
      logger.error('Failed to open log directory:', error);
    }
  };

  // 自动清除成功/错误消息
  useEffect(() => {
    if (importSuccess) {
      const timer = setTimeout(() => setImportSuccess(null), 7000);
      return () => clearTimeout(timer);
    }
  }, [importSuccess]);

  useEffect(() => {
    if (importError) {
      const timer = setTimeout(() => setImportError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [importError]);

  // 筛选控制
  const handleFilterChange = <K extends keyof QSOFilters>(key: K, value: QSOFilters[K]) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (!value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
    setCurrentPage(1); // 重置到第一页
  };

  const clearFilters = () => {
    setFilters({});
    setCurrentPage(1);
  };

  const applyDxccPresetFilters = React.useCallback((nextFilters?: QSOFilters) => {
    setFilters(nextFilters ?? {});
    setCurrentPage(1);
  }, []);

  const isAllFiltersCleared = Object.keys(filters).length === 0;
  const isWorkedFilterActive = isAllFiltersCleared;
  const isConfirmedFilterActive = filters.qslFlow === 'two_way_confirmed';
  const isDeletedFilterActive = filters.dxccStatus === 'deleted';
  const isReviewFilterActive = filters.qslFlow === 'not_two_way_confirmed';
  const isDxccBandBucketActive = (key: string) => filters.band === key;
  const isDxccModeBucketActive = (key: string) => filters.mode === key;

  // 打开编辑 Modal
  const handleEditClick = (qso: QSORecord) => {
    setEditingQSO(qso);
    setEditFormData({
      callsign: qso.callsign,
      grid: qso.grid,
      myGrid: qso.myGrid,
      myCallsign: qso.myCallsign,
      frequency: qso.frequency,
      mode: qso.mode,
      startTime: qso.startTime,
      endTime: qso.endTime,
      reportSent: qso.reportSent,
      reportReceived: qso.reportReceived,
      messages: qso.messages,
      lotwQslSent: qso.lotwQslSent,
      lotwQslReceived: qso.lotwQslReceived,
      qrzQslSent: qso.qrzQslSent,
      qrzQslReceived: qso.qrzQslReceived,
    });
    setIsEditModalOpen(true);
  };

  // 保存编辑
  const handleEditSave = async () => {
    if (!editingQSO) return;

    try {
      setIsEditSaving(true);
      await api.updateQSO(effectiveLogBookId, editingQSO.id, editFormData);

      // 重新加载数据
      await refreshLogbookData();

      // 关闭 Modal
      setIsEditModalOpen(false);
      setEditingQSO(null);
      setEditFormData({});

      logger.debug('QSO record updated successfully');
    } catch (error) {
      logger.error('Failed to update QSO record:', error);
      setError(error instanceof Error ? error.message : t('error.updateQSOFailed'));
    } finally {
      setIsEditSaving(false);
    }
  };

  // 打开删除确认 Modal
  const handleDeleteClick = (qso: QSORecord) => {
    setDeletingQSO(qso);
    setIsDeleteModalOpen(true);
  };

  // 确认删除
  const handleDeleteConfirm = async () => {
    if (!deletingQSO) return;

    try {
      setIsDeleting(true);
      await api.deleteQSO(effectiveLogBookId, deletingQSO.id);

      // 重新加载数据
      await refreshLogbookData();

      // 关闭 Modal
      setIsDeleteModalOpen(false);
      setDeletingQSO(null);

      logger.debug('QSO record deleted successfully');
    } catch (error) {
      logger.error('Failed to delete QSO record:', error);
      setError(error instanceof Error ? error.message : t('error.deleteQSOFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  // 补录：保存新 QSO 记录
  const handleAddSave = async () => {
    const { callsign, frequency, mode: qsoMode, startTime } = addFormData;
    if (!callsign?.trim() || !frequency || !qsoMode || !startTime) return;

    const payload: CreateQSORequest = {
      callsign: callsign.trim(),
      frequency,
      mode: qsoMode,
      startTime,
      grid: addFormData.grid,
      reportSent: addFormData.reportSent,
      reportReceived: addFormData.reportReceived,
      messages: addFormData.messages ?? [],
    };

    try {
      setIsAddSaving(true);
      await api.createQSO(effectiveLogBookId, payload);
      await refreshLogbookData();
      setIsAddModalOpen(false);
      setAddFormData({ callsign: '', mode: 'FT8', messages: [] });
      logger.debug('QSO record created manually');
    } catch (error) {
      logger.error('Failed to create QSO record:', error);
      setError(error instanceof Error ? error.message : t('error.createQSOFailed'));
    } finally {
      setIsAddSaving(false);
    }
  };

  // 打开外部链接的函数
  const openExternalLink = (url: string) => {
    if (isElectron()) {
      // Electron环境：尝试使用shell.openExternal
      if (typeof window !== 'undefined' && window.electronAPI?.shell?.openExternal) {
        window.electronAPI.shell.openExternal(url);
      } else {
        // 如果shell API不可用，回退到window.open
        logger.warn('Electron shell API unavailable, falling back to window.open');
        window.open(url, '_blank');
      }
    } else {
      // 浏览器环境：使用window.open
      window.open(url, '_blank');
    }
  };

  // 格式化日期显示
  const formatDateTime = (timestamp: number, compact = false) => {
    if (compact) {
      // 移动端紧凑格式
      return new Date(timestamp).toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC'
      });
    }
    // 桌面端完整格式
    return new Date(timestamp).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    }) + ' UTC';
  };

  // 格式化频率显示
  const formatFrequency = (frequencyHz: number) => {
    if (frequencyHz >= 1_000_000_000) {
      // 大于等于1GHz - 保留6位小数，去除尾随零
      const ghz = frequencyHz / 1_000_000_000;
      return `${parseFloat(ghz.toFixed(6))} GHz`;
    } else if (frequencyHz >= 1_000_000) {
      // 大于等于1MHz - 保留6位小数，去除尾随零
      const mhz = frequencyHz / 1_000_000;
      return `${parseFloat(mhz.toFixed(6))} MHz`;
    } else if (frequencyHz >= 1_000) {
      // 大于等于1KHz - 保留3位小数，去除尾随零
      const khz = frequencyHz / 1_000;
      return `${parseFloat(khz.toFixed(3))} KHz`;
    } else {
      // 小于1KHz，显示Hz
      return `${frequencyHz} Hz`;
    }
  };

  // 表格列定义（响应式）
  const columns = useMemo(() => [
    { key: 'startTime', label: t('column.timeUtc'), sortable: true, hideOnMobile: false },
    { key: 'callsign', label: t('column.callsign'), sortable: true, hideOnMobile: false },
    { key: 'grid', label: t('column.grid'), sortable: true, hideOnMobile: true },
    { key: 'myGrid', label: t('column.myGrid'), sortable: true, hideOnMobile: true },
    { key: 'frequency', label: t('column.frequency'), sortable: true, hideOnMobile: false },
    { key: 'mode', label: t('column.mode'), sortable: true, hideOnMobile: true },
    { key: 'reportSent', label: t('column.reportSent'), sortable: false, hideOnMobile: true },
    { key: 'reportReceived', label: t('column.reportReceived'), sortable: false, hideOnMobile: true },
    { key: 'qslStatus', label: t('column.qslStatus'), sortable: false, hideOnMobile: true },
    { key: 'actions', label: t('column.actions'), sortable: false, hideOnMobile: false },
  ], [t]);

  // 渲染单元格内容
  const renderCell = React.useCallback((qso: QSORecord, columnKey: React.Key) => {
    const cellValue = qso[columnKey as keyof QSORecord];

    switch (columnKey) {
      case "startTime":
        return (
          <div className="flex flex-col">
            <span className="hidden md:inline">{formatDateTime(qso.startTime)}</span>
            <span className="md:hidden text-xs">{formatDateTime(qso.startTime, true)}</span>
          </div>
        );
      case "callsign":
        return (
          <div className="flex flex-col gap-1">
            <div className="font-semibold flex items-center gap-1 md:gap-2">
              <span className="text-sm md:text-base">{qso.callsign}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openExternalLink(`https://www.qrz.com/db/${qso.callsign}`);
                }}
                className="text-default-400 hover:text-primary transition-colors"
                title={t('qso.callsignInfo', { callsign: qso.callsign })}
              >
                <FontAwesomeIcon icon={faExternalLinkAlt} size="sm" />
              </button>
            </div>
            {(qso.dxccEntity || qso.dxccId) && (
              <div className="flex flex-wrap items-center gap-1 text-xs text-default-500">
                {qso.dxccEntity && <span>{qso.dxccEntity}</span>}
                {qso.dxccId && <span>· DXCC {qso.dxccId}</span>}
                {qso.dxccStatus === 'deleted' && (
                  <Chip size="sm" variant="flat" color="warning" className="h-4">
                    {t('editQso.statusValue.deleted')}
                  </Chip>
                )}
              </div>
            )}
          </div>
        );
      case "grid":
        return qso.grid ? (
          <Chip size="sm" variant="flat" color="primary">
            {qso.grid}
          </Chip>
        ) : '-';
      case "myGrid":
        return qso.myGrid ? (
          <Chip size="sm" variant="flat" color="default">
            {qso.myGrid}
          </Chip>
        ) : '-';
      case "frequency":
        return qso.frequency ? (
          <span className="text-xs md:text-sm whitespace-nowrap">
            {formatFrequency(qso.frequency)}
          </span>
        ) : '-';
      case "mode":
        return (
          <Chip size="sm" variant="flat" color="secondary">
            {qso.mode}
          </Chip>
        );
      case "reportSent":
        return qso.reportSent || '-';
      case "reportReceived":
        return qso.reportReceived || '-';
      case "qslStatus": {
        const isLotwConfirmed = qso.lotwQslReceived === 'Y' || qso.lotwQslReceived === 'V';
        const isQrzConfirmed = qso.qrzQslReceived === 'Y';
        const isLotwSent = qso.lotwQslSent === 'Y';
        const isQrzSent = qso.qrzQslSent === 'Y';
        const isConfirmed = isLotwConfirmed || isQrzConfirmed;
        const isUploaded = isLotwSent || isQrzSent;

        if (!isConfirmed && !isUploaded) {
          return <span className="text-default-300">-</span>;
        }

        // Build tooltip details
        const details: string[] = [];
        if (isLotwConfirmed) {
          details.push(qso.lotwQslReceivedDate
            ? t('qso.lotwConfirmedDate', { date: new Date(qso.lotwQslReceivedDate).toLocaleDateString(undefined, { timeZone: 'UTC' }) })
            : t('qso.lotwConfirmed'));
        } else if (isLotwSent) {
          details.push(qso.lotwQslSentDate
            ? t('qso.lotwUploadedDate', { date: new Date(qso.lotwQslSentDate).toLocaleDateString(undefined, { timeZone: 'UTC' }) })
            : t('qso.lotwUploaded'));
        }
        if (isQrzConfirmed) {
          details.push(qso.qrzQslReceivedDate
            ? t('qso.qrzConfirmedDate', { date: new Date(qso.qrzQslReceivedDate).toLocaleDateString(undefined, { timeZone: 'UTC' }) })
            : t('qso.qrzConfirmed'));
        } else if (isQrzSent) {
          details.push(qso.qrzQslSentDate
            ? t('qso.qrzUploadedDate', { date: new Date(qso.qrzQslSentDate).toLocaleDateString(undefined, { timeZone: 'UTC' }) })
            : t('qso.qrzUploaded'));
        }

        return (
          <Tooltip content={details.join(', ')}>
            <Chip
              size="sm"
              variant="flat"
              color={isConfirmed ? 'success' : 'primary'}
            >
              {isConfirmed ? t('qslStatus.confirmed') : t('qslStatus.uploaded')}
            </Chip>
          </Tooltip>
        );
      }
      case "actions":
        return (
          <div className="flex items-center gap-1 md:gap-2">
            <Tooltip content={t('action.edit')}>
              <Button
                size="sm"
                variant="light"
                isIconOnly
                onPress={() => handleEditClick(qso)}
                className="min-w-unit-8 w-8 h-8"
              >
                <FontAwesomeIcon icon={faEdit} className="text-primary text-sm" />
              </Button>
            </Tooltip>
            <Tooltip content={t('action.delete')}>
              <Button
                size="sm"
                variant="light"
                color="danger"
                isIconOnly
                onPress={() => handleDeleteClick(qso)}
                className="min-w-unit-8 w-8 h-8"
              >
                <FontAwesomeIcon icon={faTrash} className="text-sm" />
              </Button>
            </Tooltip>
          </div>
        );
      default:
        return cellValue;
    }
  }, [t]);

  const titleSection = React.useMemo(() => (
    <div className="flex items-center gap-3">
      <h1 className="text-xl md:text-2xl font-bold text-foreground">
        {t('title')}
      </h1>
      {operatorCallsign && (
        <div className="flex items-center gap-2">
          <span className="text-default-500 hidden md:inline">-</span>
          <div className="bg-primary-50 dark:bg-primary-100/20 text-primary-600 dark:text-primary-400 px-2 md:px-3 py-1 md:py-1.5 rounded-full text-xs md:text-sm font-mono font-medium">
            {operatorCallsign}
          </div>
        </div>
      )}
    </div>
  ), [operatorCallsign, t]);

  const desktopGlobeTitleOverlay = React.useMemo(() => (
    <div className="max-w-sm text-white">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-2xl font-semibold tracking-tight text-white">
            {t('title')}
          </p>
          {operatorCallsign && (
            <span className="font-mono text-sm text-sky-100/90">
              {operatorCallsign}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-200/82">
          {hasFilters
            ? t('stats.filtered', { filtered: totalRecords, total: actualTotalRecords })
            : t('stats.total', { total: actualTotalRecords })}
        </p>
        {statistics && (
          <p className="text-sm text-slate-300/74">
            {t('stats.uniqueCallsigns', { count: statistics.uniqueCallsigns })}
          </p>
        )}
      </div>
    </div>
  ), [actualTotalRecords, hasFilters, operatorCallsign, statistics, t, totalRecords]);

  const desktopDxccOverlay = React.useMemo(() => {
    if (!statistics?.dxcc) {
      return null;
    }

    const viewOptions: Array<{ key: DxccViewMode; label: string }> = [
      { key: 'mixed', label: t('stats.dxccViewMixed') },
      { key: 'band', label: t('stats.dxccViewBand') },
      { key: 'mode', label: t('stats.dxccViewMode') },
    ];

    const currentWorked = statistics.dxcc.worked.current;
    const totalWorked = statistics.dxcc.worked.total;
    const deletedWorked = statistics.dxcc.worked.deleted;
    const currentConfirmed = statistics.dxcc.confirmed.current;
    const totalConfirmed = statistics.dxcc.confirmed.total;
    const deletedConfirmed = statistics.dxcc.confirmed.deleted;
    const getMetricCardClassName = (active: boolean) => `w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
      active
        ? 'border-[rgba(148,163,184,0.12)] bg-[rgba(96,165,250,0.18)] text-sky-100'
        : 'border-[rgba(148,163,184,0.08)] bg-[rgba(15,23,42,0.18)] hover:border-[rgba(148,163,184,0.14)] hover:bg-[rgba(15,23,42,0.24)]'
    }`;
    const getBucketClassName = (active: boolean) => `flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
      active
        ? 'border-[rgba(148,163,184,0.12)] bg-[rgba(96,165,250,0.18)] text-sky-100'
        : 'border-[rgba(148,163,184,0.06)] bg-[rgba(255,255,255,0.02)] hover:border-[rgba(148,163,184,0.12)] hover:bg-[rgba(255,255,255,0.04)]'
    }`;

    return (
      <div className="flex h-auto max-h-full w-full max-w-[280px] min-w-[280px] self-end flex-col overflow-hidden rounded-3xl border border-[rgba(148,163,184,0.12)] bg-[rgba(15,23,42,0.28)] px-4 py-4 text-white backdrop-blur-md">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-300/70">{t('stats.dxccOverview')}</p>
          <div className="inline-flex rounded-full border border-[rgba(148,163,184,0.12)] bg-[rgba(15,23,42,0.2)] p-1">
            {viewOptions.map((option) => {
              const active = dxccViewMode === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setDxccViewMode(option.key)}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? 'bg-[rgba(96,165,250,0.18)] text-sky-100'
                      : 'text-slate-300/72 hover:text-white'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
            {dxccViewMode === 'mixed' ? (
              <>
                <button
                  type="button"
                  onClick={() => applyDxccPresetFilters(undefined)}
                  className={getMetricCardClassName(isWorkedFilterActive)}
                >
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300/70">{t('stats.dxccWorked')}</p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <p className="text-3xl font-semibold text-sky-200">{currentWorked}</p>
                    {deletedWorked > 0 && (
                      <Tooltip
                        content={t('stats.dxccDeletedHelp', { count: deletedWorked })}
                        placement="top"
                        delay={150}
                      >
                        <p className="cursor-help text-[11px] text-[rgba(203,213,225,0.45)]">
                          {t('stats.dxccTotalOnly', { total: totalWorked })}
                        </p>
                      </Tooltip>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => applyDxccPresetFilters({ qslFlow: 'two_way_confirmed' })}
                  className={getMetricCardClassName(isConfirmedFilterActive)}
                >
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300/70">{t('stats.dxccConfirmed')}</p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <p className="text-3xl font-semibold text-emerald-200">{currentConfirmed}</p>
                    {deletedConfirmed > 0 && (
                      <Tooltip
                        content={t('stats.dxccDeletedHelp', { count: deletedConfirmed })}
                        placement="top"
                        delay={150}
                      >
                        <p className="cursor-help text-[11px] text-[rgba(203,213,225,0.45)]">
                          {t('stats.dxccTotalOnly', { total: totalConfirmed })}
                        </p>
                      </Tooltip>
                    )}
                  </div>
                </button>
              </>
            ) : (
              <div className="rounded-2xl border border-[rgba(148,163,184,0.08)] bg-[rgba(15,23,42,0.18)] px-3 py-3">
                <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-300/62">
                  <span>{dxccViewMode === 'band' ? t('stats.dxccByBand') : t('stats.dxccByMode')}</span>
                  <span>{t('stats.dxccTopBuckets')}</span>
                </div>
                <div className="space-y-2">
                  {dxccBucketItems.length > 0 ? (
                    dxccBucketItems.map((bucket) => (
                      <button
                        key={bucket.key}
                        type="button"
                        onClick={() => applyDxccPresetFilters(dxccViewMode === 'band' ? { band: bucket.key } : { mode: bucket.key })}
                        className={getBucketClassName(dxccViewMode === 'band' ? isDxccBandBucketActive(bucket.key) : isDxccModeBucketActive(bucket.key))}
                      >
                        <span className="min-w-0 truncate text-sm font-medium text-slate-100">{bucket.key}</span>
                        <span className="shrink-0 text-[11px] text-slate-300/78">
                          {t('stats.dxccBucketCompact', { worked: bucket.worked, confirmed: bucket.confirmed })}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="rounded-xl border border-[rgba(148,163,184,0.06)] bg-[rgba(255,255,255,0.02)] px-3 py-3 text-sm text-slate-300/72">
                      {t('stats.dxccNoBucketData')}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => applyDxccPresetFilters({ dxccStatus: 'deleted' })}
                className={getMetricCardClassName(isDeletedFilterActive)}
              >
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300/70">{t('stats.dxccDeleted')}</p>
                <p className="mt-2 text-xl font-semibold text-amber-200">{statistics.dxcc.worked.deleted}</p>
              </button>
              <button
                type="button"
                onClick={() => applyDxccPresetFilters({ qslFlow: 'not_two_way_confirmed' })}
                className={getMetricCardClassName(isReviewFilterActive)}
              >
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-300/70">{t('stats.dxccReview')}</p>
                <p className="mt-2 text-xl font-semibold text-fuchsia-200">{statistics.dxcc.reviewCount}</p>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }, [applyDxccPresetFilters, dxccBucketItems, dxccViewMode, isConfirmedFilterActive, isDeletedFilterActive, isDxccBandBucketActive, isDxccModeBucketActive, isReviewFilterActive, isWorkedFilterActive, statistics, t]);

  const mobileDxccSummary = React.useMemo(() => {
    if (!statistics?.dxcc) {
      return null;
    }

    const viewOptions: Array<{ key: DxccViewMode; label: string }> = [
      { key: 'mixed', label: t('stats.dxccViewMixed') },
      { key: 'band', label: t('stats.dxccViewBand') },
      { key: 'mode', label: t('stats.dxccViewMode') },
    ];

    return (
      <div className="rounded-xl border border-default-200 bg-default-50/60 lg:hidden">
        <div className="space-y-3 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-default-700">{t('stats.dxccOverview')}</p>
            <div className="inline-flex rounded-full border border-default-200 bg-white/70 p-1 dark:bg-default-100/10">
              {viewOptions.map((option) => {
                const active = dxccViewMode === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setDxccViewMode(option.key)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? 'bg-primary/12 text-primary'
                        : 'text-default-500'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          {dxccViewMode === 'mixed' ? (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => applyDxccPresetFilters(undefined)}
                className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${isWorkedFilterActive ? 'border-primary/20 bg-primary/12 text-primary' : 'border-default-200 bg-white/70 dark:bg-default-100/10'}`}
              >
                <p className="text-xs text-default-500">{t('stats.dxccWorked')}</p>
                <p className="mt-1 text-lg font-semibold text-primary">{statistics.dxcc.worked.current}</p>
                <p className="mt-1 text-[11px] text-default-500">
                  {t('stats.dxccTotalWithDeleted', {
                    total: statistics.dxcc.worked.total,
                    deleted: statistics.dxcc.worked.deleted,
                  })}
                </p>
              </button>
              <button
                type="button"
                onClick={() => applyDxccPresetFilters({ qslFlow: 'two_way_confirmed' })}
                className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${isConfirmedFilterActive ? 'border-primary/20 bg-primary/12 text-primary' : 'border-default-200 bg-white/70 dark:bg-default-100/10'}`}
              >
                <p className="text-xs text-default-500">{t('stats.dxccConfirmed')}</p>
                <p className="mt-1 text-lg font-semibold text-success">{statistics.dxcc.confirmed.current}</p>
                <p className="mt-1 text-[11px] text-default-500">
                  {t('stats.dxccTotalWithDeleted', {
                    total: statistics.dxcc.confirmed.total,
                    deleted: statistics.dxcc.confirmed.deleted,
                  })}
                </p>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {dxccBucketItems.length > 0 ? (
                dxccBucketItems.map((bucket) => (
                  <button
                    key={bucket.key}
                    type="button"
                    onClick={() => applyDxccPresetFilters(dxccViewMode === 'band' ? { band: bucket.key } : { mode: bucket.key })}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                      (dxccViewMode === 'band' ? isDxccBandBucketActive(bucket.key) : isDxccModeBucketActive(bucket.key))
                        ? 'border-primary/20 bg-primary/12 text-primary'
                        : 'border-default-200 bg-white/70 dark:bg-default-100/10'
                    }`}
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-default-700">{bucket.key}</span>
                    <span className="shrink-0 text-[11px] text-default-500">
                      {t('stats.dxccBucketCompact', { worked: bucket.worked, confirmed: bucket.confirmed })}
                    </span>
                  </button>
                ))
              ) : (
                <div className="rounded-xl border border-default-200 bg-white/70 px-3 py-3 text-sm text-default-500 dark:bg-default-100/10">
                  {t('stats.dxccNoBucketData')}
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => applyDxccPresetFilters({ dxccStatus: 'deleted' })}
              className={`rounded-xl border px-3 py-3 text-left transition-colors ${isDeletedFilterActive ? 'border-primary/20 bg-primary/12 text-primary' : 'border-default-200 bg-white/70 dark:bg-default-100/10'}`}
            >
              <p className="text-xs text-default-500">{t('stats.dxccDeleted')}</p>
              <p className="text-lg font-semibold text-warning">{statistics.dxcc.worked.deleted}</p>
            </button>
            <button
              type="button"
              onClick={() => applyDxccPresetFilters({ qslFlow: 'not_two_way_confirmed' })}
              className={`rounded-xl border px-3 py-3 text-left transition-colors ${isReviewFilterActive ? 'border-primary/20 bg-primary/12 text-primary' : 'border-default-200 bg-white/70 dark:bg-default-100/10'}`}
            >
              <p className="text-xs text-default-500">{t('stats.dxccReview')}</p>
              <p className="text-lg font-semibold text-secondary">{statistics.dxcc.reviewCount}</p>
            </button>
          </div>
        </div>
      </div>
    );
  }, [applyDxccPresetFilters, dxccBucketItems, dxccViewMode, isConfirmedFilterActive, isDeletedFilterActive, isDxccBandBucketActive, isDxccModeBucketActive, isReviewFilterActive, isWorkedFilterActive, statistics, t]);

  // 顶部内容：标题和操作工具
  const topContent = React.useMemo(() => {
    const searchAndFilterControls = (
      <>
        {isSearchExpanded ? (
          <Input
            autoFocus
            isClearable
            size="sm"
            className="w-40 md:w-64 transition-all duration-200"
            placeholder={t('filter.searchPlaceholder')}
            startContent={<SearchIcon />}
            value={filters.callsign || ''}
            onClear={() => handleFilterChange('callsign', undefined)}
            onValueChange={(value) => handleFilterChange('callsign', value)}
            onBlur={() => {
              if (!filters.callsign) {
                setIsSearchExpanded(false);
              }
            }}
          />
        ) : (
          <Button
            variant="flat"
            size="sm"
            startContent={<SearchIcon className="hidden md:inline" />}
            onPress={() => setIsSearchExpanded(true)}
            className="transition-all duration-200 min-w-0"
          >
            <span className="hidden md:inline">{t('action.search')}</span>
            <SearchIcon className="md:hidden" />
          </Button>
        )}

        {isGridSearchExpanded ? (
          <Input
            autoFocus
            isClearable
            size="sm"
            className="w-36 md:w-32 transition-all duration-200"
            placeholder={t('filter.gridPlaceholder')}
            startContent={<FontAwesomeIcon icon={faTableCells} className="text-default-400 text-xs" />}
            value={filters.grid || ''}
            onClear={() => handleFilterChange('grid', undefined)}
            onValueChange={(value) => handleFilterChange('grid', normalizeGridFilterValue(value))}
            onBlur={() => {
              if (!filters.grid) {
                setIsGridSearchExpanded(false);
              }
            }}
          />
        ) : (
          <Button
            variant="flat"
            size="sm"
            color={filters.grid ? 'primary' : 'default'}
            startContent={<FontAwesomeIcon icon={faTableCells} className="hidden md:inline text-xs" />}
            onPress={() => setIsGridSearchExpanded(true)}
            className="transition-all duration-200 min-w-0"
          >
            <span className="hidden md:inline">{t('filter.grid')}</span>
            <FontAwesomeIcon icon={faTableCells} className="md:hidden text-xs" />
          </Button>
        )}

        <Dropdown>
          <DropdownTrigger>
            <Button
              variant="flat"
              size="sm"
              endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs hidden md:inline" />}
              color={filters.band ? "primary" : "default"}
              className="min-w-0"
            >
              <span className="hidden md:inline">{t('filter.band')}{filters.band ? `: ${filters.band}` : ''}</span>
              <span className="md:hidden">{filters.band || t('filter.band')}</span>
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('filter.bandFilter')}
            selectedKeys={filters.band ? [filters.band] : []}
            selectionMode="single"
            onSelectionChange={(keys) => {
              const selected = Array.from(keys as Set<string>);
              handleFilterChange('band', selected[0]);
            }}
          >
            <DropdownItem key="">{t('filter.allBands')}</DropdownItem>
            <DropdownItem key="160m">160m (1.8MHz)</DropdownItem>
            <DropdownItem key="80m">80m (3.5MHz)</DropdownItem>
            <DropdownItem key="60m">60m (5MHz)</DropdownItem>
            <DropdownItem key="40m">40m (7MHz)</DropdownItem>
            <DropdownItem key="30m">30m (10MHz)</DropdownItem>
            <DropdownItem key="20m">20m (14MHz)</DropdownItem>
            <DropdownItem key="17m">17m (18MHz)</DropdownItem>
            <DropdownItem key="15m">15m (21MHz)</DropdownItem>
            <DropdownItem key="12m">12m (24MHz)</DropdownItem>
            <DropdownItem key="10m">10m (28MHz)</DropdownItem>
            <DropdownItem key="6m">6m (50MHz)</DropdownItem>
            <DropdownItem key="4m">4m (70MHz)</DropdownItem>
            <DropdownItem key="2m">2m (144MHz)</DropdownItem>
            <DropdownItem key="1.25m">1.25m (222MHz)</DropdownItem>
            <DropdownItem key="70cm">70cm (430MHz)</DropdownItem>
            <DropdownItem key="33cm">33cm (902MHz)</DropdownItem>
            <DropdownItem key="23cm">23cm (1.2GHz)</DropdownItem>
          </DropdownMenu>
        </Dropdown>

        <Dropdown>
          <DropdownTrigger>
            <Button
              variant="flat"
              size="sm"
              endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs hidden md:inline" />}
              color={filters.mode ? "primary" : "default"}
              className="min-w-0"
            >
              <span className="hidden md:inline">{t('filter.mode')}{filters.mode ? `: ${filters.mode}` : ''}</span>
              <span className="md:hidden">{filters.mode || t('filter.mode')}</span>
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('filter.modeFilter')}
            selectedKeys={filters.mode ? [filters.mode] : []}
            selectionMode="single"
            onSelectionChange={(keys) => {
              const selected = Array.from(keys as Set<string>);
              handleFilterChange('mode', selected[0]);
            }}
          >
            <DropdownItem key="">{t('filter.allModes')}</DropdownItem>
            <DropdownItem key="FT8">FT8</DropdownItem>
            <DropdownItem key="FT4">FT4</DropdownItem>
          </DropdownMenu>
        </Dropdown>

        <Dropdown>
          <DropdownTrigger>
            <Button
              variant="flat"
              size="sm"
              endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs hidden md:inline" />}
              color={filters.dxccStatus ? "primary" : "default"}
              className="min-w-0"
            >
              <span className="hidden md:inline">{filters.dxccStatus === 'deleted' ? t('filter.dxccDeleted') : t('filter.dxccStatus')}</span>
              <span className="md:hidden">{filters.dxccStatus === 'deleted' ? t('filter.dxccDeleted') : t('filter.dxccStatus')}</span>
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('filter.dxccStatusFilter')}
            selectedKeys={filters.dxccStatus ? [filters.dxccStatus] : []}
            selectionMode="single"
            onSelectionChange={(keys) => {
              const selected = Array.from(keys as Set<string>);
              const value = selected[0] || undefined;
              handleFilterChange('dxccStatus', value as QSOFilters['dxccStatus']);
            }}
          >
            <DropdownItem key="">{t('filter.allDxccStatus')}</DropdownItem>
            <DropdownItem key="deleted">{t('filter.dxccDeleted')}</DropdownItem>
          </DropdownMenu>
        </Dropdown>

        <Dropdown>
          <DropdownTrigger>
            <Button
              variant="flat"
              size="sm"
              endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs hidden md:inline" />}
              color={filters.qslFlow ? "primary" : "default"}
              className="min-w-0"
            >
              <span className="hidden md:inline">
                {filters.qslFlow === 'two_way_confirmed'
                  ? t('filter.qslFlowTwoWayConfirmed')
                  : filters.qslFlow === 'not_two_way_confirmed'
                    ? t('filter.qslFlowNotTwoWayConfirmed')
                    : t('filter.qslFlow')}
              </span>
              <span className="md:hidden">
                {filters.qslFlow === 'two_way_confirmed'
                  ? t('filter.qslFlowTwoWayConfirmed')
                  : filters.qslFlow === 'not_two_way_confirmed'
                    ? t('filter.qslFlowNotTwoWayConfirmed')
                    : t('filter.qslFlow')}
              </span>
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('filter.qslFlowFilter')}
            selectedKeys={filters.qslFlow ? [filters.qslFlow] : []}
            selectionMode="single"
            onSelectionChange={(keys) => {
              const selected = Array.from(keys as Set<string>);
              const value = selected[0] || undefined;
              handleFilterChange('qslFlow', value as QSOFilters['qslFlow']);
            }}
          >
            <DropdownItem key="">{t('filter.allQslFlow')}</DropdownItem>
            <DropdownItem key="two_way_confirmed">{t('filter.qslFlowTwoWayConfirmed')}</DropdownItem>
            <DropdownItem key="not_two_way_confirmed">{t('filter.qslFlowNotTwoWayConfirmed')}</DropdownItem>
          </DropdownMenu>
        </Dropdown>

        <Dropdown>
          <DropdownTrigger>
            <Button
              variant="flat"
              size="sm"
              endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs hidden md:inline" />}
              color={filters.qslStatus ? "primary" : "default"}
              className="min-w-0 hidden md:flex"
            >
              {filters.qslStatus === 'confirmed' ? t('qslStatus.confirmed') : filters.qslStatus === 'uploaded' ? t('qslStatus.uploaded') : filters.qslStatus === 'none' ? t('qslStatus.notUploaded') : t('qslStatus.confirmStatus')}
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('filter.confirmFilter')}
            selectedKeys={filters.qslStatus ? [filters.qslStatus] : []}
            selectionMode="single"
            onSelectionChange={(keys) => {
              const selected = Array.from(keys as Set<string>);
              const value = selected[0] || undefined;
              handleFilterChange('qslStatus', value as QSOFilters['qslStatus']);
            }}
          >
            <DropdownItem key="">{t('qslStatus.allStatus')}</DropdownItem>
            <DropdownItem key="confirmed">{t('qslStatus.confirmed')}</DropdownItem>
            <DropdownItem key="uploaded">{t('qslStatus.uploadedNotConfirmed')}</DropdownItem>
            <DropdownItem key="none">{t('qslStatus.notUploaded')}</DropdownItem>
          </DropdownMenu>
        </Dropdown>

        {Object.keys(filters).length > 0 && (
          <Button
            variant="light"
            color="danger"
            size="sm"
            onPress={clearFilters}
            className="min-w-0 whitespace-nowrap"
          >
            <span className="hidden md:inline">{t('action.clearFilter')}</span>
            <span className="md:hidden">{t('action.clear')}</span>
          </Button>
        )}
      </>
    );

    const actionControls = (
      <>
        {/* Plugin-based sync provider buttons (dynamic) */}
        {syncProviders.map((provider) => {
          const isConfigured = syncConfigured[provider.id] ?? false;
          const isBusy = syncingProviders[provider.id] ?? false;
          const name = provider.displayName;

          // Resolve action icon
          const actionIcon = (icon?: string) => {
            if (icon === 'download') return faDownload;
            if (icon === 'upload') return faUpload;
            return faSync;
          };

          // i18n for well-known action ids; external plugins fall back to raw label
          const ACTION_I18N: Record<string, { label: string; desc: string }> = {
            download: { label: t('sync.provider.download'), desc: t('sync.provider.downloadDesc', { name }) },
            upload: { label: t('sync.provider.upload'), desc: t('sync.provider.uploadDesc', { name }) },
            full_sync: { label: t('sync.provider.fullSync'), desc: t('sync.provider.fullSyncDesc') },
          };
          const resolveLabel = (a: SyncAction) => ACTION_I18N[a.id]?.label ?? a.label;
          const resolveDesc = (a: SyncAction) => ACTION_I18N[a.id]?.desc ?? a.description;

          // Use provider-defined actions or default set
          const defaultActions: SyncAction[] = [
            { id: 'download', label: 'Download', icon: 'download', operation: 'download' },
            { id: 'upload', label: 'Upload', icon: 'upload', operation: 'upload' },
            { id: 'full_sync', label: 'Full Sync', icon: 'sync', operation: 'full_sync' },
          ];
          const providerActions = provider.actions ?? defaultActions;

          return (
            <Dropdown key={provider.id}>
              <DropdownTrigger>
                <Button
                  color={(provider.color ?? 'default') as 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger'}
                  variant="bordered"
                  size="sm"
                  isLoading={isBusy}
                  startContent={!isBusy ? <FontAwesomeIcon icon={faSync} /> : undefined}
                  className="min-w-0"
                >
                  <span className="hidden lg:inline">{name}</span>
                  <span className="lg:hidden hidden md:inline">{t('sync.sync')}</span>
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label={t('sync.provider.ariaLabel', { name })}
                onAction={(key) => {
                  if (key === 'settings') {
                    openSyncConfig(provider.id);
                  } else {
                    const action = providerActions.find(a => a.id === String(key));
                    if (action?.pageId) {
                      // Open iframe modal for this action
                      setActionModal({
                        pluginName: provider.pluginName,
                        pageId: action.pageId,
                        title: `${name} — ${resolveLabel(action)}`,
                      });
                    } else if (action?.operation) {
                      void handleProviderSync(provider.id, action.operation);
                    }
                  }
                }}
              >
                {isConfigured ? [
                  ...providerActions.map((action) => (
                    <DropdownItem
                      key={action.id}
                      startContent={<FontAwesomeIcon icon={actionIcon(action.icon)} className={action.icon === 'download' ? 'text-primary' : action.icon === 'upload' ? 'text-secondary' : 'text-warning'} />}
                      description={resolveDesc(action)}
                    >
                      {resolveLabel(action)}
                    </DropdownItem>
                  )),
                  <DropdownItem
                    key="settings"
                    startContent={<FontAwesomeIcon icon={faCog} className="text-default-400" />}
                    description={t('sync.provider.settingsDesc', { name })}
                  >
                    {t('sync.provider.settings')}
                  </DropdownItem>,
                ] : [
                  <DropdownItem
                    key="settings"
                    startContent={<FontAwesomeIcon icon={faCog} />}
                    description={t('sync.provider.notConfigured')}
                  >
                    {t('sync.provider.settings')}
                  </DropdownItem>,
                ]}
              </DropdownMenu>
            </Dropdown>
          );
        })}


        <Dropdown>
          <DropdownTrigger>
            <Button
              color="primary"
              variant="bordered"
              size="sm"
              isLoading={isExporting}
              disabled={qsos.length === 0}
              className="min-w-0"
              startContent={<FontAwesomeIcon icon={faDownload} className="md:hidden" />}
            >
              <span className="hidden md:inline">{t('export.button')}</span>
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('export.ariaLabel')}
            onAction={(key) => handleExport(key as 'adif' | 'csv')}
          >
            <DropdownItem key="adif">{t('export.adif')}</DropdownItem>
            <DropdownItem key="csv">{t('export.csv')}</DropdownItem>
          </DropdownMenu>
        </Dropdown>

        <Button
          color="secondary"
          variant="bordered"
          size="sm"
          isLoading={isImporting}
          onPress={triggerImportPicker}
          className="min-w-0"
          startContent={!isImporting ? <FontAwesomeIcon icon={faUpload} className="md:hidden" /> : undefined}
        >
          <span className="hidden md:inline">{t('import.button')}</span>
        </Button>

        <Button
          color="primary"
          variant="flat"
          size="sm"
          startContent={<FontAwesomeIcon icon={faPlus} />}
          onPress={() => {
            setAddFormData({ callsign: '', mode: 'FT8', messages: [] });
            setIsAddModalOpen(true);
          }}
          className="min-w-0"
        >
          <span className="hidden md:inline">{t('addQso.button')}</span>
        </Button>

        {isElectron() && (
          <Tooltip content={t('action.openDataDir')}>
            <Button
              variant="flat"
              size="sm"
              isIconOnly
              onPress={handleOpenDataDir}
              className="min-w-0"
            >
              <FontAwesomeIcon icon={faFolderOpen} />
            </Button>
          </Tooltip>
        )}

        {operatorCallsign && (
          <Tooltip content={t('action.configSync')}>
            <Button
              variant="flat"
              size="sm"
              isIconOnly
              onPress={() => openSyncConfig('wavelog')}
              className="min-w-0"
            >
              <FontAwesomeIcon icon={faCog} />
            </Button>
          </Tooltip>
        )}
      </>
    );

    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          <div className="lg:hidden">
            {titleSection}
          </div>
          <div className="flex flex-col gap-2 md:gap-3">
            <input
              ref={importFileInputRef}
              type="file"
              accept=".adi,.ADI,.adif,.ADIF,.csv,.CSV"
              className="hidden"
              onChange={handleImportFileSelected}
            />
            <div className="flex flex-wrap items-center gap-2 md:hidden">
              {searchAndFilterControls}
            </div>

            <div className="flex flex-wrap items-center gap-2 md:hidden">
              {actionControls}
            </div>

            <div className="hidden md:flex md:items-start md:justify-between md:gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {searchAndFilterControls}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {actionControls}
              </div>
            </div>
          </div>
        </div>

        {/* 统计信息 */}
        <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-2 text-xs md:text-small text-default-500">
          <span>
            {hasFilters
              ? t('stats.filtered', { filtered: totalRecords, total: actualTotalRecords })
              : t('stats.total', { total: actualTotalRecords })
            }
          </span>
          {statistics && (
            <span className="flex flex-wrap gap-2 md:gap-0">
              <span>{t('stats.uniqueCallsigns', { count: statistics.uniqueCallsigns })}</span>
              {statistics.firstQSO && (
                <span className="hidden md:inline"> | {t('stats.firstQSO', { date: new Date(statistics.firstQSO).toLocaleDateString(undefined, { timeZone: 'UTC' }) })}</span>
              )}
              {statistics.lastQSO && (
                <span className="hidden md:inline"> | {t('stats.lastQSO', { date: new Date(statistics.lastQSO).toLocaleDateString(undefined, { timeZone: 'UTC' }) })}</span>
              )}
            </span>
          )}
        </div>

        {mobileDxccSummary}
      </div>
    );
  }, [
    t,
    titleSection,
    isSearchExpanded,
    isGridSearchExpanded,
    filters.callsign,
    filters.grid,
    filters.band,
    filters.mode,
    filters.qslStatus,
    totalRecords,
    actualTotalRecords,
    hasFilters,
    statistics,
    isExporting,
    handleFilterChange,
    clearFilters,
    handleExport,
    openSyncConfig,
    mobileDxccSummary,
  ]);

  // 底部内容：分页
  const bottomContent = React.useMemo(() => {
    return (
      <div className="py-2 px-2 flex flex-col md:flex-row justify-between items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-default-500">{t('pagination.pageSize')}</span>
          <Dropdown>
            <DropdownTrigger>
              <Button
                size="sm"
                variant="flat"
                className="min-w-0 text-xs md:text-sm"
                endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs" />}
              >
                {t('pagination.pageSizeOption', { count: itemsPerPage })}
              </Button>
            </DropdownTrigger>
            <DropdownMenu
              aria-label={t('pagination.pageSize')}
              selectedKeys={[String(itemsPerPage)]}
              selectionMode="single"
              onSelectionChange={(keys) => {
                const selected = Array.from(keys as Set<string>);
                const value = Number(selected[0]);
                handleItemsPerPageChange(value);
              }}
            >
              {PAGE_SIZE_OPTIONS.map((option) => (
                <DropdownItem key={String(option)}>
                  {t('pagination.pageSizeOption', { count: option })}
                </DropdownItem>
              ))}
            </DropdownMenu>
          </Dropdown>
        </div>
        <div className="flex items-center gap-2">
          {totalPages > 1 && (
            <Pagination
              isCompact
              showControls
              showShadow
              color="primary"
              page={currentPage}
              total={totalPages}
              onChange={(page) => {
                setCurrentPage(page);
              }}
              classNames={{
                wrapper: "gap-0 overflow-visible h-8",
                item: "w-8 h-8 text-xs min-w-8",
                cursor: "shadow-sm",
              }}
            />
          )}
          <Button
            size="sm"
            variant="flat"
            onPress={() => {
              setCurrentPage(1);
            }}
            isDisabled={currentPage === 1 || totalPages <= 1}
            className="min-w-0 text-xs md:text-sm"
          >
            <span className="hidden md:inline">{t('pagination.firstPage')}</span>
            <span className="md:hidden">{t('pagination.firstPageShort')}</span>
          </Button>
          <Button
            size="sm"
            variant="flat"
            onPress={() => {
              setCurrentPage(totalPages);
            }}
            isDisabled={currentPage === totalPages || totalPages <= 1}
            className="min-w-0 text-xs md:text-sm"
          >
            <span className="hidden md:inline">{t('pagination.lastPage')}</span>
            <span className="md:hidden">{t('pagination.lastPageShort')}</span>
          </Button>
        </div>
      </div>
    );
  }, [t, currentPage, totalPages, itemsPerPage]);

  // 计算加载状态的内容
  const loadingState = loading ? "loading" : "idle";

  // 如果有错误，显示错误信息
  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6 max-w-7xl mx-auto">
        <Alert
          color="danger"
          title={t('error.loadFailed')}
          description={error}
          endContent={
            <Button
              color="danger"
              variant="light"
              onPress={() => {
                setError(null);
                refreshLogbookData().catch(() => {});
              }}
            >
              {t('error.retry')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="w-full">
      <RecentQSOGlobeCard
        logBookId={effectiveLogBookId}
        qsos={qsos}
        loading={loading}
        bandFilter={filters.band}
        pageSize={itemsPerPage}
        pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
        onPageSizeChange={handleItemsPerPageChange}
        desktopLeftOverlay={desktopGlobeTitleOverlay}
        desktopRightOverlay={desktopDxccOverlay}
      />

      <div className="p-2 md:p-4 lg:p-6 max-w-7xl mx-auto">
      {/* 通知区域 */}
      {/* Plugin-based sync provider messages */}
      {Object.entries(syncMessages).map(([providerId, msg]) => {
        const providerName = syncProviders.find(p => p.id === providerId)?.displayName ?? providerId;
        const title = msg.type === 'success'
          ? t('sync.provider.syncSuccess', { name: providerName })
          : t('sync.provider.syncError', { name: providerName });
        return (
          <Alert
            key={providerId}
            color={msg.type === 'success' ? 'success' : 'danger'}
            variant="flat"
            className="w-full mb-4"
            title={title}
            description={msg.text}
            isClosable
            onClose={() => setSyncMessages(prev => { const next = { ...prev }; delete next[providerId]; return next; })}
          />
        );
      })}


      {exportError && (
        <Alert
          color="danger"
          variant="flat"
          className="w-full mb-4"
          title={t('export.errorTitle')}
          description={exportError}
          isClosable
          onClose={() => setExportError(null)}
        />
      )}

      {importSuccess && (
        <Alert
          color="success"
          variant="flat"
          className="w-full mb-4"
          title={t('import.successTitle')}
          description={importSuccess}
          isClosable
          onClose={() => setImportSuccess(null)}
        />
      )}

      {importError && (
        <Alert
          color="danger"
          variant="flat"
          className="w-full mb-4"
          title={t('import.errorTitle')}
          description={importError}
          isClosable
          onClose={() => setImportError(null)}
        />
      )}

      {/* 表格 */}
      <Table
        aria-label={t('qso.tableAriaLabel')}
        bottomContent={bottomContent}
        bottomContentPlacement="outside"
        classNames={{
          wrapper: "overflow-visible",
          base: "overflow-x-visible",
          table: "min-w-full",
        }}
        sortDescriptor={sortDescriptor}
        topContent={topContent}
        topContentPlacement="outside"
        onSortChange={(descriptor) => setSortDescriptor(descriptor as { column: string; direction: 'ascending' | 'descending' })}
      >
        <TableHeader columns={columns}>
          {(column) => (
            <TableColumn
              key={column.key}
              allowsSorting={column.sortable}
              className={column.hideOnMobile ? 'hidden md:table-cell' : ''}
            >
              {column.label}
            </TableColumn>
          )}
        </TableHeader>
        <TableBody
          items={qsos}
          loadingContent={<Spinner />}
          loadingState={loadingState}
          emptyContent={t('empty')}
        >
          {(qso) => (
            <TableRow key={qso.id}>
              {(columnKey) => {
                const column = columns.find(c => c.key === columnKey);
                return (
                  <TableCell className={column?.hideOnMobile ? 'hidden md:table-cell' : ''}>
                    {renderCell(qso, columnKey)}
                  </TableCell>
                );
              }}
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* 编辑 Modal */}
      <QSOFormModal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingQSO(null);
          setEditFormData({});
        }}
        title={t('editQso.title')}
        formData={editFormData}
        onChange={setEditFormData}
        onSave={handleEditSave}
        isSaving={isEditSaving}
        mode="edit"
      />

      {/* 删除确认 Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setDeletingQSO(null);
        }}
        size="sm"
      >
        <ModalContent>
          <ModalHeader>
            <h3 className="text-lg font-semibold text-danger">{t('deleteQso.title')}</h3>
          </ModalHeader>
          <ModalBody>
            {deletingQSO && (
              <div className="space-y-3">
                <p className="text-default-600">
                  {t('deleteQso.confirm', { callsign: deletingQSO.callsign })}
                </p>
                <div className="p-3 bg-default-100 rounded-lg space-y-1">
                  <p className="text-sm"><span className="font-medium">{t('deleteQso.time')}</span> {formatDateTime(deletingQSO.startTime)}</p>
                  <p className="text-sm"><span className="font-medium">{t('deleteQso.frequency')}</span> {formatFrequency(deletingQSO.frequency)}</p>
                  <p className="text-sm"><span className="font-medium">{t('deleteQso.mode')}</span> {deletingQSO.mode}</p>
                </div>
                <div className="p-3 bg-danger-50 dark:bg-danger-100/20 border border-danger-200 dark:border-danger-400/30 rounded-lg">
                  <p className="text-danger-700 dark:text-danger-400 text-sm">
                    {t('deleteQso.warning')}
                  </p>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={() => {
                setIsDeleteModalOpen(false);
                setDeletingQSO(null);
              }}
            >
              {t('common:button.cancel')}
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteConfirm}
              isLoading={isDeleting}
            >
              {t('deleteQso.confirmDelete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 补录 QSO Modal */}
      <QSOFormModal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setAddFormData({ callsign: '', mode: 'FT8', messages: [] });
        }}
        title={t('addQso.title')}
        formData={addFormData}
        onChange={setAddFormData}
        onSave={handleAddSave}
        isSaving={isAddSaving}
        mode="add"
      />

      <Modal
        isOpen={isImportGuideOpen}
        onClose={() => setIsImportGuideOpen(false)}
        size="lg"
      >
        <ModalContent>
          <ModalHeader>{t('import.guideTitle')}</ModalHeader>
          <ModalBody className="gap-4">
            <p className="text-sm text-default-600">
              {t('import.guideDesc')}
            </p>

            <Alert color="primary" variant="flat">
              <div className="space-y-2 text-sm">
                <p className="font-medium">{t('import.supportedFormatsTitle')}</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>
                    <span className="font-medium">{t('import.adif')}</span>
                    {' - '}
                    {t('import.adifDesc')}
                  </li>
                  <li>
                    <span className="font-medium">{t('import.csv')}</span>
                    {' - '}
                    {t('import.csvDesc')}
                  </li>
                </ul>
              </div>
            </Alert>

            <div className="space-y-2 text-sm text-default-700">
              <p className="font-medium text-default-900">{t('import.requirementsTitle')}</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>{t('import.requirementAdifFields')}</li>
                <li>{t('import.requirementCsvHeaders')}</li>
                <li>{t('import.requirementMerge')}</li>
              </ul>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={() => setIsImportGuideOpen(false)}
            >
              {t('common:button.cancel')}
            </Button>
            <Button
              color="secondary"
              onPress={handleImportGuideConfirm}
            >
              {t('import.pickFile')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>


      {/* 同步配置弹窗 */}
      {operatorCallsign && (
        <SyncConfigModal
          isOpen={isSyncConfigOpen}
          onClose={() => setIsSyncConfigOpen(false)}
          callsign={operatorCallsign}
          initialTab={syncConfigInitialTab}
          onSaved={() => {
            refreshSyncProviders(operatorCallsign).catch(() => {});
          }}
        />
      )}

      {/* Sync action iframe modal (for pageId-based actions) */}
      <Modal
        isOpen={!!actionModal}
        onClose={() => {
          setActionModal(null);
          // Refresh logbook data in case the action modified records
          refreshLogbookData();
        }}
        size="lg"
      >
        <ModalContent className="overflow-hidden">
          <ModalHeader>{actionModal?.title}</ModalHeader>
          <ModalBody className="p-0">
            {actionModal && (
              <PluginIframeHost
                pluginName={actionModal.pluginName}
                pageId={actionModal.pageId}
                params={{ callsign: operatorCallsign || '' }}
                minHeight={0}
              />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
      </div>
    </div>
  );
};

export default LogbookViewer;
