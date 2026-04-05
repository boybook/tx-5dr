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
import type { QSORecord, LogBookStatistics, WaveLogSyncResponse, QRZSyncResponse, LoTWSyncResponse, LoTWUploadPreflightResponse, LoTWSyncStatus, CreateQSORequest, LogBookImportResult } from '@tx5dr/contracts';
import { api, WSClient, ApiError } from '@tx5dr/core';
import { getLogbookWebSocketUrl } from '../utils/config';
import { isElectron } from '../utils/config';
import { showErrorToast } from '../utils/errorToast';
import { SyncConfigModal } from './SyncConfigModal';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../utils/logger';

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
}

function normalizeGridFilterValue(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '').slice(0, 8);
}

function formatDateInputValue(timestamp?: number): string {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return '';
  }

  return new Date(timestamp).toISOString().slice(0, 10);
}

function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

const LogbookViewer: React.FC<LogbookViewerProps> = ({ operatorId, logBookId, operatorCallsign }) => {
  const { t } = useTranslation('logbook');
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const getLoTWIssueMessage = (issue: { code: string; message: string }) => {
    const key = `lotwSettings.issue.${issue.code}`;
    const translated = t(key);
    return translated === key ? issue.message : translated;
  };
  const getLoTWGuidanceMessage = (guidanceKey: string) => {
    const key = `lotwSettings.guidance.${guidanceKey}`;
    const translated = t(key);
    return translated === key ? guidanceKey : translated;
  };
  const translateLoTWServerMessage = (message?: string | null, fallback?: string) => {
    if (!message) {
      return fallback || t('sync.lotw.syncError');
    }
    const key = `lotwSettings.serverError.${message}`;
    const translated = t(key);
    return translated === key ? (fallback || message) : translated;
  };
  const getLoTWApiErrorMessage = (error: ApiError) => {
    return translateLoTWServerMessage(error.message, error.userMessage);
  };
  const [qsos, setQsos] = useState<QSORecord[]>([]);
  const [statistics, setStatistics] = useState<LogBookStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<QSOFilters>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(50);
  const [totalRecords, setTotalRecords] = useState(0);
  const [actualTotalRecords, setActualTotalRecords] = useState(0);
  const [hasFilters, setHasFilters] = useState(false);
  const [sortDescriptor, setSortDescriptor] = useState<{
    column: string;
    direction: 'ascending' | 'descending';
  }>({ column: 'startTime', direction: 'descending' });
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [isGridSearchExpanded, setIsGridSearchExpanded] = useState(false);
  const [isDxccStatsExpanded, setIsDxccStatsExpanded] = useState(false);

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
    const wsJwt = localStorage.getItem('tx5dr_jwt') || undefined;
    const url = getLogbookWebSocketUrl({ operatorId, token: wsJwt });
    const client = new WSClient({ url, heartbeatInterval: 30000 });

    const refresh = () => {
      // 保持当前筛选与分页，重新加载
      loadQSOs();
      loadStatistics();
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

  // 初始加载与筛选/分页变化时加载
  useEffect(() => {
    loadQSOs();
    loadStatistics();
  }, [effectiveLogBookId, filters, currentPage]);

  // 加载呼号的同步配置摘要
  useEffect(() => {
    if (operatorCallsign) {
      refreshSyncSummary(operatorCallsign).catch(() => {});
      refreshLoTWStatus(operatorCallsign).catch(() => {});
    }
  }, [operatorCallsign]);

  // 总页数计算 - 基于筛选后的记录数
  const totalPages = useMemo(() => {
    const pages = Math.ceil(totalRecords / itemsPerPage);
    return pages;
  }, [totalRecords, itemsPerPage, currentPage]);

  // 导出功能（增强错误处理）
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportGuideOpen, setIsImportGuideOpen] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // WaveLog同步功能
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState<string | null>(null);

  // QRZ同步状态
  const [isQRZSyncing, setIsQRZSyncing] = useState(false);
  const [qrzSyncError, setQrzSyncError] = useState<string | null>(null);
  const [qrzSyncSuccess, setQrzSyncSuccess] = useState<string | null>(null);

  // LoTW同步状态
  const [isLoTWSyncing, setIsLoTWSyncing] = useState(false);
  const [lotwSyncError, setLotwSyncError] = useState<string | null>(null);
  const [lotwSyncSuccess, setLotwSyncSuccess] = useState<string | null>(null);
  const [isLoTWDownloadModalOpen, setIsLoTWDownloadModalOpen] = useState(false);
  const [isLoTWUploadModalOpen, setIsLoTWUploadModalOpen] = useState(false);
  const [isCheckingLoTWUpload, setIsCheckingLoTWUpload] = useState(false);
  const [lotwUploadPreflight, setLotwUploadPreflight] = useState<LoTWUploadPreflightResponse | null>(null);
  const [lotwSyncSinceDate, setLotwSyncSinceDate] = useState('');
  const [lotwLastDownloadTime, setLotwLastDownloadTime] = useState<number | undefined>(undefined);

  // 平台启用状态（旧的，保留兼容）
  const [_isQRZEnabled, setIsQRZEnabled] = useState(false);
  const [_isLoTWEnabled, setIsLoTWEnabled] = useState(false);

  // 同步配置摘要（按呼号）
  const [syncSummary, setSyncSummary] = useState<{ wavelog: boolean; qrz: boolean; lotw: boolean }>({ wavelog: false, qrz: false, lotw: false });
  const [isSyncConfigOpen, setIsSyncConfigOpen] = useState(false);
  const [syncConfigInitialTab, setSyncConfigInitialTab] = useState<'wavelog' | 'qrz' | 'lotw'>('wavelog');

  const refreshSyncSummary = async (callsign: string) => {
    const res = await api.getCallsignSyncSummary(callsign) as {
      success?: boolean;
      summary?: { wavelog: boolean; qrz: boolean; lotw: boolean };
    };

    if (res.success && res.summary) {
      setSyncSummary(res.summary);
      setIsQRZEnabled(res.summary.qrz);
      setIsLoTWEnabled(res.summary.lotw);
    }
  };

  const refreshLoTWStatus = async (callsign: string) => {
    const status = await api.getLoTWSyncStatus(callsign) as LoTWSyncStatus;
    setLotwLastDownloadTime(status.lastDownloadTime);
  };

  const getDefaultLoTWSinceDate = () => formatDateInputValue(lotwLastDownloadTime) || getDateDaysAgo(30);

  const openSyncConfig = (tab: 'wavelog' | 'qrz' | 'lotw' = 'wavelog') => {
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

      await loadQSOs();
      await loadStatistics();

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

  // WaveLog同步功能
  const handleWaveLogSync = async (operation: 'download' | 'upload' | 'full_sync') => {
    if (isSyncing) return;

    try {
      setIsSyncing(true);
      setSyncError(null);
      setSyncSuccess(null);

      // 调用WaveLog同步API
      const result = await api.syncWaveLog(operatorCallsign || '', operation) as WaveLogSyncResponse;

      if (result.success) {
        setSyncSuccess(result.message);
        // 同步成功后重新加载QSO数据
        await loadQSOs();
        await loadStatistics();

        logger.debug(`WaveLog sync successful: ${operation}`);
      } else {
        setSyncError(result.message || t('error.syncFailed'));
      }

    } catch (error) {
      logger.error('WaveLog sync failed:', error);
      if (error instanceof ApiError) {
        setSyncError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        const errorMessage = error instanceof Error ? error.message : t('sync.wavelog.syncError');
        setSyncError(errorMessage);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  // QRZ.com同步功能
  const handleQRZSync = async (operation: 'download' | 'upload' | 'full_sync') => {
    if (isQRZSyncing) return;

    try {
      setIsQRZSyncing(true);
      setQrzSyncError(null);
      setQrzSyncSuccess(null);

      const result = await api.syncQRZ(operatorCallsign || '', operation) as QRZSyncResponse;

      if (result.success) {
        setQrzSyncSuccess(result.message);
        await loadQSOs();
        await loadStatistics();
      } else {
        setQrzSyncError(result.message || t('sync.qrz.syncError'));
      }
    } catch (error) {
      logger.error('QRZ sync failed:', error);
      if (error instanceof ApiError) {
        setQrzSyncError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        setQrzSyncError(error instanceof Error ? error.message : t('sync.qrz.syncError'));
      }
    } finally {
      setIsQRZSyncing(false);
    }
  };

  // LoTW同步功能
  const handleLoTWSync = async (
    operation: 'upload' | 'download_confirmations',
    since?: string
  ) => {
    if (isLoTWSyncing) return;

    try {
      setIsLoTWSyncing(true);
      setLotwSyncError(null);
      setLotwSyncSuccess(null);

      const result = await api.syncLoTW(operatorCallsign || '', operation, since) as LoTWSyncResponse;

      if (result.success) {
        const successMessage = operation === 'download_confirmations'
          ? t('sync.lotw.downloadResult', {
            downloaded: result.downloadedCount ?? 0,
            updated: result.updatedCount ?? 0,
            imported: result.importedCount ?? 0,
          })
          : result.message;

        setLotwSyncSuccess(successMessage);
        await loadQSOs();
        await loadStatistics();
        if (operatorCallsign) {
          await refreshLoTWStatus(operatorCallsign);
        }
      } else {
        const errorMessage = translateLoTWServerMessage(result.errorCode || result.message, result.message || t('sync.lotw.syncError'));
        setLotwSyncError(errorMessage);
        showErrorToast({
          userMessage: errorMessage,
          severity: 'warning',
        });
      }
    } catch (error) {
      logger.error('LoTW sync failed:', error);
      if (error instanceof ApiError) {
        const errorMessage = getLoTWApiErrorMessage(error);
        setLotwSyncError(errorMessage);
        showErrorToast({
          userMessage: errorMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        setLotwSyncError(error instanceof Error ? error.message : t('sync.lotw.syncError'));
      }
    } finally {
      setIsLoTWSyncing(false);
    }
  };

  const openLoTWDownloadModal = () => {
    setLotwSyncSinceDate(getDefaultLoTWSinceDate());
    setIsLoTWDownloadModalOpen(true);
  };

  const closeLoTWDownloadModal = () => {
    if (isLoTWSyncing) return;
    setIsLoTWDownloadModalOpen(false);
  };

  const handleLoTWDownloadConfirm = async () => {
    if (!lotwSyncSinceDate) {
      setLotwSyncError(t('sync.lotw.selectDateRequired'));
      return;
    }

    setIsLoTWDownloadModalOpen(false);
    await handleLoTWSync('download_confirmations', lotwSyncSinceDate);
  };

  const openLoTWUploadModal = async () => {
    if (!operatorCallsign || isCheckingLoTWUpload) return;

    setIsLoTWUploadModalOpen(true);
    setLotwUploadPreflight(null);
    setIsCheckingLoTWUpload(true);
    setLotwSyncError(null);

    try {
      const result = await api.getLoTWUploadPreflight(operatorCallsign);
      setLotwUploadPreflight(result);
    } catch (error) {
      logger.error('LoTW upload preflight failed:', error);
      if (error instanceof ApiError) {
        const errorMessage = getLoTWApiErrorMessage(error);
        setLotwSyncError(errorMessage);
        showErrorToast({
          userMessage: errorMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code,
        });
      } else {
        setLotwSyncError(error instanceof Error ? error.message : t('sync.lotw.syncError'));
      }
      setIsLoTWUploadModalOpen(false);
    } finally {
      setIsCheckingLoTWUpload(false);
    }
  };

  const closeLoTWUploadModal = () => {
    if (isLoTWSyncing || isCheckingLoTWUpload) return;
    setIsLoTWUploadModalOpen(false);
  };

  const handleLoTWUploadConfirm = async () => {
    if (!lotwUploadPreflight?.ready || lotwUploadPreflight.uploadableCount === 0) {
      return;
    }

    setIsLoTWUploadModalOpen(false);
    await handleLoTWSync('upload');
  };

  const handleLoTWAction = (operation: 'upload' | 'download_confirmations') => {
    if (operation === 'download_confirmations') {
      openLoTWDownloadModal();
      return;
    }

    void openLoTWUploadModal();
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
    if (syncSuccess) {
      const timer = setTimeout(() => setSyncSuccess(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [syncSuccess]);

  useEffect(() => {
    if (syncError) {
      const timer = setTimeout(() => setSyncError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [syncError]);

  useEffect(() => {
    if (qrzSyncSuccess) {
      const timer = setTimeout(() => setQrzSyncSuccess(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [qrzSyncSuccess]);

  useEffect(() => {
    if (qrzSyncError) {
      const timer = setTimeout(() => setQrzSyncError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [qrzSyncError]);

  useEffect(() => {
    if (lotwSyncSuccess) {
      const timer = setTimeout(() => setLotwSyncSuccess(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [lotwSyncSuccess]);

  useEffect(() => {
    if (lotwSyncError) {
      const timer = setTimeout(() => setLotwSyncError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [lotwSyncError]);

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
      await loadQSOs();
      await loadStatistics();

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
      await loadQSOs();
      await loadStatistics();

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
      await loadQSOs();
      await loadStatistics();
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

  // 顶部内容：标题和操作工具
  const topContent = React.useMemo(() => {
    return (
      <div className="flex flex-col gap-4">
        {/* 标题和操作按钮 */}
        <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
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

          <div className="flex items-center gap-2 overflow-x-visible overflow-y-visible pb-2 md:pb-0">
            <input
              ref={importFileInputRef}
              type="file"
              accept=".adi,.ADI,.adif,.ADIF,.csv,.CSV"
              className="hidden"
              onChange={handleImportFileSelected}
            />

            {/* 可展开的搜索框 */}
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

            {/* 筛选按钮 */}
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

            {/* WaveLog同步按钮 - 仅在WaveLog启用时显示 */}
            {syncSummary.wavelog && (
              <Dropdown>
                <DropdownTrigger>
                  <Button
                    color="secondary"
                    variant="bordered"
                    size="sm"
                    isLoading={isSyncing}
                    startContent={!isSyncing ? <FontAwesomeIcon icon={faSync} /> : undefined}
                    className="min-w-0"
                  >
                    <span className="hidden lg:inline">{t('sync.wavelog.button')}</span>
                    <span className="lg:hidden hidden md:inline">{t('sync.sync')}</span>
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label={t('sync.wavelog.ariaLabel')}
                  onAction={(key) => handleWaveLogSync(key as 'download' | 'upload' | 'full_sync')}
                >
                  <DropdownItem
                    key="download"
                    startContent={<FontAwesomeIcon icon={faDownload} className="text-primary" />}
                    description={t('sync.wavelog.downloadDesc')}
                  >
                    {t('sync.wavelog.download')}
                  </DropdownItem>
                  <DropdownItem
                    key="upload"
                    startContent={<FontAwesomeIcon icon={faUpload} className="text-secondary" />}
                    description={t('sync.wavelog.uploadDesc')}
                  >
                    {t('sync.wavelog.upload')}
                  </DropdownItem>
                  <DropdownItem
                    key="full_sync"
                    startContent={<FontAwesomeIcon icon={faSync} className="text-warning" />}
                    description={t('sync.wavelog.fullSyncDesc')}
                  >
                    {t('sync.wavelog.fullSync')}
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
            )}

            {/* QRZ.com同步按钮 - 仅在QRZ启用时显示 */}
            {syncSummary.qrz && (
              <Dropdown>
                <DropdownTrigger>
                  <Button
                    color="warning"
                    variant="bordered"
                    size="sm"
                    isLoading={isQRZSyncing}
                    startContent={!isQRZSyncing ? <FontAwesomeIcon icon={faSync} /> : undefined}
                    className="min-w-0"
                  >
                    <span className="hidden lg:inline">QRZ.com</span>
                    <span className="lg:hidden hidden md:inline">QRZ</span>
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label={t('sync.qrz.ariaLabel')}
                  onAction={(key) => handleQRZSync(key as 'download' | 'upload' | 'full_sync')}
                >
                  <DropdownItem
                    key="download"
                    startContent={<FontAwesomeIcon icon={faDownload} className="text-primary" />}
                    description={t('sync.qrz.downloadDesc')}
                  >
                    {t('sync.qrz.download')}
                  </DropdownItem>
                  <DropdownItem
                    key="upload"
                    startContent={<FontAwesomeIcon icon={faUpload} className="text-secondary" />}
                    description={t('sync.qrz.uploadDesc')}
                  >
                    {t('sync.qrz.upload')}
                  </DropdownItem>
                  <DropdownItem
                    key="full_sync"
                    startContent={<FontAwesomeIcon icon={faSync} className="text-warning" />}
                    description={t('sync.qrz.fullSyncDesc')}
                  >
                    {t('sync.qrz.fullSync')}
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
            )}

            {/* LoTW同步按钮 - 仅在LoTW启用时显示 */}
            {syncSummary.lotw && (
              <Dropdown>
                <DropdownTrigger>
                  <Button
                    color="success"
                    variant="bordered"
                    size="sm"
                    isLoading={isLoTWSyncing}
                    startContent={!isLoTWSyncing ? <FontAwesomeIcon icon={faSync} /> : undefined}
                    className="min-w-0"
                  >
                    <span className="hidden lg:inline">LoTW</span>
                    <span className="lg:hidden hidden md:inline">LoTW</span>
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label={t('sync.lotw.ariaLabel')}
                  onAction={(key) => handleLoTWAction(key as 'upload' | 'download_confirmations')}
                >
                  <DropdownItem
                    key="download_confirmations"
                    startContent={<FontAwesomeIcon icon={faDownload} className="text-primary" />}
                    description={t('sync.lotw.downloadConfirmationsDesc')}
                  >
                    {t('sync.lotw.downloadConfirmations')}
                  </DropdownItem>
                  <DropdownItem
                    key="upload"
                    startContent={<FontAwesomeIcon icon={faUpload} className="text-secondary" />}
                    description={t('sync.lotw.uploadDesc')}
                  >
                    {t('sync.lotw.upload')}
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
            )}

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

            {/* 补录按钮 */}
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

            {/* 打开日志文件目录按钮 - 仅Electron */}
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

            {/* 同步配置齿轮按钮 */}
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

        {statistics?.dxcc && (
          <div className="rounded-xl border border-default-200 bg-default-50/60">
            <div className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-default-700">{t('stats.dxccOverview')}</p>
                <div className="flex flex-wrap gap-2">
                  <Chip size="sm" variant="flat" color="primary">
                    {t('stats.dxccWorked')}: {statistics.dxcc.worked.current}
                  </Chip>
                  <Chip size="sm" variant="flat" color="success">
                    {t('stats.dxccConfirmed')}: {statistics.dxcc.confirmed.current}
                  </Chip>
                  <Chip size="sm" variant="flat" color="warning">
                    {t('stats.dxccDeleted')}: {statistics.dxcc.worked.deleted}
                  </Chip>
                  <Chip size="sm" variant="flat" color="secondary">
                    {t('stats.dxccReview')}: {statistics.dxcc.reviewCount}
                  </Chip>
                </div>
              </div>

              <Button
                size="sm"
                variant="light"
                endContent={(
                  <FontAwesomeIcon
                    icon={faChevronDown}
                    className={`transition-transform ${isDxccStatsExpanded ? 'rotate-180' : ''}`}
                  />
                )}
                onPress={() => setIsDxccStatsExpanded((value) => !value)}
              >
                {isDxccStatsExpanded ? t('stats.collapseDxcc') : t('stats.expandDxcc')}
              </Button>
            </div>

            {isDxccStatsExpanded && (
              <div className="grid grid-cols-1 gap-3 border-t border-default-200 px-4 py-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-xl border border-default-200 bg-white/70 px-3 py-3 dark:bg-default-100/10">
                    <p className="text-xs text-default-500">{t('stats.dxccWorked')}</p>
                    <p className="text-lg font-semibold text-primary">{statistics.dxcc.worked.current}</p>
                    <p className="text-xs text-default-500">
                      {t('stats.dxccWorkedCount', {
                        current: statistics.dxcc.worked.current,
                        total: statistics.dxcc.worked.total,
                      })}
                    </p>
                  </div>
                  <div className="rounded-xl border border-default-200 bg-white/70 px-3 py-3 dark:bg-default-100/10">
                    <p className="text-xs text-default-500">{t('stats.dxccConfirmed')}</p>
                    <p className="text-lg font-semibold text-success">{statistics.dxcc.confirmed.current}</p>
                    <p className="text-xs text-default-500">
                      {t('stats.dxccConfirmedCount', {
                        current: statistics.dxcc.confirmed.current,
                        total: statistics.dxcc.confirmed.total,
                      })}
                    </p>
                  </div>
                  <div className="rounded-xl border border-default-200 bg-white/70 px-3 py-3 dark:bg-default-100/10">
                    <p className="text-xs text-default-500">{t('stats.dxccDeleted')}</p>
                    <p className="text-lg font-semibold text-warning">{statistics.dxcc.worked.deleted}</p>
                    <p className="text-xs text-default-500">
                      {t('stats.dxccDeletedCount', { count: statistics.dxcc.worked.deleted })}
                    </p>
                  </div>
                  <div className="rounded-xl border border-default-200 bg-white/70 px-3 py-3 dark:bg-default-100/10">
                    <p className="text-xs text-default-500">{t('stats.dxccReview')}</p>
                    <p className="text-lg font-semibold text-secondary">{statistics.dxcc.reviewCount}</p>
                    <p className="text-xs text-default-500">
                      {t('stats.dxccReviewCount', { count: statistics.dxcc.reviewCount })}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-default-200 bg-white/70 px-3 py-3 dark:bg-default-100/10">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-default-500">{t('stats.dxccByBand')}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {statistics.dxcc.byBand.length > 0 ? statistics.dxcc.byBand.slice(0, 8).map((bucket) => (
                      <Chip key={`band-${bucket.key}`} size="sm" variant="flat" color="primary">
                        {bucket.key} · {t('stats.dxccBucketCount', { worked: bucket.worked, confirmed: bucket.confirmed })}
                      </Chip>
                    )) : <span className="text-xs text-default-400">-</span>}
                  </div>
                </div>

                <div className="rounded-xl border border-default-200 bg-white/70 px-3 py-3 dark:bg-default-100/10">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-default-500">{t('stats.dxccByMode')}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {statistics.dxcc.byMode.length > 0 ? statistics.dxcc.byMode.slice(0, 8).map((bucket) => (
                      <Chip key={`mode-${bucket.key}`} size="sm" variant="flat" color="secondary">
                        {bucket.key} · {t('stats.dxccBucketCount', { worked: bucket.worked, confirmed: bucket.confirmed })}
                      </Chip>
                    )) : <span className="text-xs text-default-400">-</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }, [
    t,
    operatorCallsign,
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
    isQRZSyncing,
    isLoTWSyncing,
    syncSummary,
    openSyncConfig,
    handleQRZSync,
    handleLoTWAction
  ]);

  // 底部内容：分页
  const bottomContent = React.useMemo(() => {
    // 如果只有一页，不显示分页组件
    if (totalPages <= 1) {
      return null;
    }

    return (
      <div className="py-2 px-2 flex flex-col md:flex-row justify-between items-center gap-2">
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
        <div className="flex gap-2">
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
  }, [t, currentPage, totalPages]);

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
                loadQSOs();
                loadStatistics();
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
    <div className="p-2 md:p-4 lg:p-6 max-w-7xl mx-auto">
      {/* 通知区域 */}
      {syncSuccess && (
        <Alert
          color="success"
          variant="flat"
          className="w-full mb-4"
          title={t('sync.wavelog.successTitle')}
          description={syncSuccess}
          isClosable
          onClose={() => setSyncSuccess(null)}
        />
      )}

      {syncError && (
        <Alert
          color="danger"
          variant="flat"
          className="w-full mb-4"
          title={t('sync.wavelog.errorTitle')}
          description={syncError}
          isClosable
          onClose={() => setSyncError(null)}
        />
      )}

      {qrzSyncSuccess && (
        <Alert
          color="success"
          variant="flat"
          className="w-full mb-4"
          title={t('sync.qrz.successTitle')}
          description={qrzSyncSuccess}
          isClosable
          onClose={() => setQrzSyncSuccess(null)}
        />
      )}

      {qrzSyncError && (
        <Alert
          color="danger"
          variant="flat"
          className="w-full mb-4"
          title={t('sync.qrz.errorTitle')}
          description={qrzSyncError}
          isClosable
          onClose={() => setQrzSyncError(null)}
        />
      )}

      {lotwSyncSuccess && (
        <Alert
          color="success"
          variant="flat"
          className="w-full mb-4"
          title={t('sync.lotw.successTitle')}
          description={lotwSyncSuccess}
          isClosable
          onClose={() => setLotwSyncSuccess(null)}
        />
      )}

      {lotwSyncError && (
        <Alert
          color="danger"
          variant="flat"
          className="w-full mb-4"
          title={t('sync.lotw.errorTitle')}
          description={lotwSyncError}
          isClosable
          onClose={() => setLotwSyncError(null)}
        />
      )}

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

      <Modal
        isOpen={isLoTWDownloadModalOpen}
        onClose={closeLoTWDownloadModal}
        size="sm"
      >
        <ModalContent>
          <ModalHeader>{t('sync.lotw.dateModalTitle')}</ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm text-default-600">
              {t('sync.lotw.dateModalDesc')}
            </p>
            <Input
              type="date"
              label={t('sync.lotw.sinceDateLabel')}
              value={lotwSyncSinceDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(event) => setLotwSyncSinceDate(event.target.value)}
              description={lotwLastDownloadTime
                ? t('sync.lotw.lastDownloadHint', {
                  time: new Date(lotwLastDownloadTime).toLocaleString(undefined, { timeZone: 'UTC' }),
                })
                : t('sync.lotw.noLastDownloadHint')}
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={closeLoTWDownloadModal}
              isDisabled={isLoTWSyncing}
            >
              {t('common:button.cancel')}
            </Button>
            <Button
              color="success"
              onPress={handleLoTWDownloadConfirm}
              isLoading={isLoTWSyncing}
              isDisabled={!lotwSyncSinceDate}
            >
              {t('sync.lotw.confirmDownload')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isLoTWUploadModalOpen}
        onClose={closeLoTWUploadModal}
        size="lg"
      >
        <ModalContent>
          <ModalHeader>{t('sync.lotw.uploadModalTitle')}</ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm text-default-600">
              {t('sync.lotw.uploadModalDesc')}
            </p>

            {isCheckingLoTWUpload && (
              <div className="flex items-center gap-2 py-4">
                <Spinner size="sm" />
                <span className="text-sm text-default-600">{t('sync.lotw.uploadChecking')}</span>
              </div>
            )}

            {!isCheckingLoTWUpload && lotwUploadPreflight && (
              <>
                <Alert color={lotwUploadPreflight.ready ? 'success' : 'warning'} variant="flat">
                  <div className="space-y-2">
                    <p className="font-medium">
                      {lotwUploadPreflight.ready
                        ? t('sync.lotw.uploadReadySummary')
                        : t('sync.lotw.uploadNeedsConfigSummary')}
                    </p>
                    <div className="text-xs space-y-1">
                      <p>{t('sync.lotw.uploadPendingCount', { count: lotwUploadPreflight.pendingCount })}</p>
                      <p>{t('sync.lotw.uploadReadyCount', { count: lotwUploadPreflight.uploadableCount })}</p>
                      <p>{t('sync.lotw.uploadBlockedCount', { count: lotwUploadPreflight.blockedCount })}</p>
                    </div>
                  </div>
                </Alert>

                {lotwUploadPreflight.issues.length > 0 && (
                  <Alert color={lotwUploadPreflight.ready ? 'primary' : 'warning'} variant="flat">
                    <div className="space-y-2 text-sm">
                      <p className="font-medium">{t('sync.lotw.uploadChecklist')}</p>
                      <ul className="space-y-1 text-xs">
                        {lotwUploadPreflight.issues.map((issue) => (
                          <li key={`${issue.code}-${issue.message}`}>• {getLoTWIssueMessage(issue)}</li>
                        ))}
                      </ul>
                    </div>
                  </Alert>
                )}

                {lotwUploadPreflight.selectedCertificates.length > 0 && (
                  <div className="rounded-lg bg-default-100 px-3 py-3">
                    <p className="text-sm font-medium mb-2">{t('sync.lotw.uploadCertificatesTitle')}</p>
                    <ul className="space-y-1 text-xs text-default-600">
                      {lotwUploadPreflight.selectedCertificates.map((item) => (
                        <li key={item.id}>• {t('sync.lotw.uploadCertificateItem', { callsign: item.callsign, from: new Date(item.qsoStartDate).toLocaleDateString(), to: new Date(item.qsoEndDate).toLocaleDateString() })}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {lotwUploadPreflight.guidance.length > 0 && (
                  <div className="rounded-lg bg-default-100 px-3 py-3">
                    <p className="text-sm font-medium mb-2">{t('sync.lotw.uploadGuidanceTitle')}</p>
                      <ul className="space-y-1 text-xs text-default-600">
                        {lotwUploadPreflight.guidance.map((item) => (
                          <li key={item}>• {getLoTWGuidanceMessage(item)}</li>
                        ))}
                      </ul>
                    </div>
                )}
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={closeLoTWUploadModal}
              isDisabled={isLoTWSyncing || isCheckingLoTWUpload}
            >
              {t('common:button.cancel')}
            </Button>
            <Button
              variant="flat"
              color="primary"
              onPress={() => {
                setIsLoTWUploadModalOpen(false);
                openSyncConfig('lotw');
              }}
              isDisabled={isCheckingLoTWUpload}
            >
              {t('sync.lotw.openLotwSettings')}
            </Button>
            <Button
              color="success"
              onPress={handleLoTWUploadConfirm}
              isLoading={isLoTWSyncing}
              isDisabled={
                isCheckingLoTWUpload
                || !lotwUploadPreflight?.ready
                || (lotwUploadPreflight?.uploadableCount ?? 0) === 0
              }
            >
              {t('sync.lotw.confirmUpload')}
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
            refreshSyncSummary(operatorCallsign).catch(() => {});
            refreshLoTWStatus(operatorCallsign).catch(() => {});
          }}
        />
      )}
    </div>
  );
};

export default LogbookViewer;
