import React, { useState, useEffect, useMemo } from 'react';
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
  Checkbox,
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
  Select,
  SelectItem,
} from '@heroui/react';
import { SearchIcon } from '@heroui/shared-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faSync, faDownload, faUpload, faExternalLinkAlt, faEdit, faTrash, faFolderOpen, faCog, faCloudUploadAlt, faCheckCircle } from '@fortawesome/free-solid-svg-icons';
import type { QSORecord, LogBookStatistics, WaveLogSyncResponse, QRZSyncResponse, LoTWSyncResponse, QRZConfig, LoTWConfig } from '@tx5dr/contracts';
import { api, WSClient, ApiError } from '@tx5dr/core';
import { getLogbookWebSocketUrl } from '../utils/config';
import { isElectron } from '../utils/config';
import { showErrorToast } from '../utils/errorToast';
import { SyncConfigModal } from './SyncConfigModal';

// ElectronAPI 类型定义
interface ElectronAPI {
  shell?: {
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<string>;
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
  band?: string;
  mode?: string;
  startDate?: string;
  endDate?: string;
  qslStatus?: string;
}

const LogbookViewer: React.FC<LogbookViewerProps> = ({ operatorId, logBookId, operatorCallsign }) => {
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

  // 编辑 Modal 状态
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingQSO, setEditingQSO] = useState<QSORecord | null>(null);
  const [editFormData, setEditFormData] = useState<Partial<QSORecord>>({});
  const [isEditSaving, setIsEditSaving] = useState(false);

  // 删除确认 Modal 状态
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deletingQSO, setDeletingQSO] = useState<QSORecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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
        console.log('🔔 收到日志本变更通知，刷新数据');
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
      
      console.log('📊 [LogbookViewer] 发送API请求:', {
        effectiveLogBookId,
        queryOptions,
        currentPage,
        itemsPerPage,
        calculatedOffset: (currentPage - 1) * itemsPerPage
      });
      
      const response = await api.getLogBookQSOs(effectiveLogBookId, queryOptions);
      console.log('📊 [LogbookViewer] API响应:', { 
        dataLength: response.data.length, 
        meta: response.meta,
        filteredTotal: response.meta?.total,
        actualTotalRecords: response.meta?.totalRecords,
        currentPage,
        itemsPerPage,
        calculatedTotalPages: Math.ceil((response.meta?.total || response.data.length) / itemsPerPage)
      });
      setQsos(response.data);
      // 使用筛选后的总数来计算分页
      setTotalRecords(response.meta?.total || response.data.length);
      // 保存实际总记录数用于显示
      setActualTotalRecords(response.meta?.totalRecords || response.data.length);
      setHasFilters(response.meta?.hasFilters || false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '加载QSO记录失败';
      console.error('加载QSO记录失败:', error);
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
      console.error('加载统计信息失败:', error);
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
      api.getCallsignSyncSummary(operatorCallsign).then((res: unknown) => {
        const result = res as { success?: boolean; summary?: { wavelog: boolean; qrz: boolean; lotw: boolean } };
        if (result.success && result.summary) {
          setSyncSummary(result.summary);
          // 同步到旧的启用状态以保持兼容
          setIsQRZEnabled(result.summary.qrz);
          setIsLoTWEnabled(result.summary.lotw);
        }
      }).catch(() => {});
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

  // 平台启用状态（旧的，保留兼容）
  const [isQRZEnabled, setIsQRZEnabled] = useState(false);
  const [isLoTWEnabled, setIsLoTWEnabled] = useState(false);

  // 同步配置摘要（按呼号）
  const [syncSummary, setSyncSummary] = useState<{ wavelog: boolean; qrz: boolean; lotw: boolean }>({ wavelog: false, qrz: false, lotw: false });
  const [isSyncConfigOpen, setIsSyncConfigOpen] = useState(false);
  
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
      
      console.log(`📊 成功导出 ${format.toUpperCase()} 格式日志`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '导出失败';
      console.error('导出失败:', error);
      setExportError(errorMessage);
    } finally {
      setIsExporting(false);
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

        console.log(`📊 WaveLog同步成功: ${operation}`, result);
      } else {
        setSyncError(result.message || '同步失败');
      }

    } catch (error) {
      console.error('WaveLog同步失败:', error);
      if (error instanceof ApiError) {
        setSyncError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        const errorMessage = error instanceof Error ? error.message : 'WaveLog同步失败';
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
        setQrzSyncError(result.message || 'QRZ同步失败');
      }
    } catch (error) {
      console.error('QRZ同步失败:', error);
      if (error instanceof ApiError) {
        setQrzSyncError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        setQrzSyncError(error instanceof Error ? error.message : 'QRZ同步失败');
      }
    } finally {
      setIsQRZSyncing(false);
    }
  };

  // LoTW同步功能
  const handleLoTWSync = async (operation: 'upload' | 'download_confirmations') => {
    if (isLoTWSyncing) return;

    try {
      setIsLoTWSyncing(true);
      setLotwSyncError(null);
      setLotwSyncSuccess(null);

      const result = await api.syncLoTW(operatorCallsign || '', operation) as LoTWSyncResponse;

      if (result.success) {
        setLotwSyncSuccess(result.message);
        await loadQSOs();
        await loadStatistics();
      } else {
        setLotwSyncError(result.message || 'LoTW同步失败');
      }
    } catch (error) {
      console.error('LoTW同步失败:', error);
      if (error instanceof ApiError) {
        setLotwSyncError(error.userMessage);
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code
        });
      } else {
        setLotwSyncError(error instanceof Error ? error.message : 'LoTW同步失败');
      }
    } finally {
      setIsLoTWSyncing(false);
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
      console.error('打开日志目录失败:', error);
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

  // 筛选控制
  const handleFilterChange = (key: keyof QSOFilters, value: string | undefined) => {
    setFilters(prev => ({
      ...prev,
      [key]: value || undefined,
    }));
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

      console.log('✅ QSO记录更新成功');
    } catch (error) {
      console.error('更新QSO记录失败:', error);
      setError(error instanceof Error ? error.message : '更新QSO记录失败');
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

      console.log('✅ QSO记录删除成功');
    } catch (error) {
      console.error('删除QSO记录失败:', error);
      setError(error instanceof Error ? error.message : '删除QSO记录失败');
    } finally {
      setIsDeleting(false);
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
        console.warn('Electron shell API不可用，回退到window.open');
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
      return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC'
      });
    }
    // 桌面端完整格式
    return new Date(timestamp).toLocaleString('zh-CN', {
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
  const columns = [
    { key: 'startTime', label: '时间 (UTC)', sortable: true, hideOnMobile: false },
    { key: 'callsign', label: '呼号', sortable: true, hideOnMobile: false },
    { key: 'grid', label: '网格', sortable: true, hideOnMobile: true },
    { key: 'frequency', label: '频率', sortable: true, hideOnMobile: false },
    { key: 'mode', label: '模式', sortable: true, hideOnMobile: true },
    { key: 'reportSent', label: '发送报告', sortable: false, hideOnMobile: true },
    { key: 'reportReceived', label: '接收报告', sortable: false, hideOnMobile: true },
    { key: 'qslStatus', label: '确认', sortable: false, hideOnMobile: true },
    { key: 'actions', label: '操作', sortable: false, hideOnMobile: false },
  ];

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
          <div className="font-semibold flex items-center gap-1 md:gap-2">
            <span className="text-sm md:text-base">{qso.callsign}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                openExternalLink(`https://www.qrz.com/db/${qso.callsign}`);
              }}
              className="text-default-400 hover:text-primary transition-colors"
              title={`在QRZ.com查看 ${qso.callsign} 的信息`}
            >
              <FontAwesomeIcon icon={faExternalLinkAlt} size="sm" />
            </button>
          </div>
        );
      case "grid":
        return qso.grid ? (
          <Chip size="sm" variant="flat" color="primary">
            {qso.grid}
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
          details.push(`LoTW: 已确认${qso.lotwQslReceivedDate ? ` (${new Date(qso.lotwQslReceivedDate).toLocaleDateString('zh-CN', { timeZone: 'UTC' })})` : ''}`);
        } else if (isLotwSent) {
          details.push(`LoTW: 已上传${qso.lotwQslSentDate ? ` (${new Date(qso.lotwQslSentDate).toLocaleDateString('zh-CN', { timeZone: 'UTC' })})` : ''}`);
        }
        if (isQrzConfirmed) {
          details.push(`QRZ: 已确认${qso.qrzQslReceivedDate ? ` (${new Date(qso.qrzQslReceivedDate).toLocaleDateString('zh-CN', { timeZone: 'UTC' })})` : ''}`);
        } else if (isQrzSent) {
          details.push(`QRZ: 已上传${qso.qrzQslSentDate ? ` (${new Date(qso.qrzQslSentDate).toLocaleDateString('zh-CN', { timeZone: 'UTC' })})` : ''}`);
        }

        return (
          <Tooltip content={details.join(', ')}>
            <Chip
              size="sm"
              variant="flat"
              color={isConfirmed ? 'success' : 'primary'}
            >
              {isConfirmed ? '已确认' : '已上传'}
            </Chip>
          </Tooltip>
        );
      }
      case "actions":
        return (
          <div className="flex items-center gap-1 md:gap-2">
            <Tooltip content="编辑">
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
            <Tooltip content="删除">
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
  }, []);

  // 顶部内容：标题和操作工具
  const topContent = React.useMemo(() => {
    return (
      <div className="flex flex-col gap-4">
        {/* 标题和操作按钮 */}
        <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl md:text-2xl font-bold text-foreground">
              通联日志
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
            {/* 可展开的搜索框 */}
            {isSearchExpanded ? (
              <Input
                autoFocus
                isClearable
                size="sm"
                className="w-40 md:w-64 transition-all duration-200"
                placeholder="搜索呼号..."
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
                <span className="hidden md:inline">搜索</span>
                <SearchIcon className="md:hidden" />
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
                  <span className="hidden md:inline">频段{filters.band ? `: ${filters.band}` : ''}</span>
                  <span className="md:hidden">{filters.band || '频段'}</span>
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="频段筛选"
                selectedKeys={filters.band ? [filters.band] : []}
                selectionMode="single"
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys as Set<string>);
                  handleFilterChange('band', selected[0]);
                }}
              >
                <DropdownItem key="">全部频段</DropdownItem>
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
                  <span className="hidden md:inline">模式{filters.mode ? `: ${filters.mode}` : ''}</span>
                  <span className="md:hidden">{filters.mode || '模式'}</span>
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="模式筛选"
                selectedKeys={filters.mode ? [filters.mode] : []}
                selectionMode="single"
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys as Set<string>);
                  handleFilterChange('mode', selected[0]);
                }}
              >
                <DropdownItem key="">全部模式</DropdownItem>
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
                  {filters.qslStatus === 'confirmed' ? '已确认' : filters.qslStatus === 'uploaded' ? '已上传' : filters.qslStatus === 'none' ? '未上传' : '确认'}
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="确认状态筛选"
                selectedKeys={filters.qslStatus ? [filters.qslStatus] : []}
                selectionMode="single"
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys as Set<string>);
                  handleFilterChange('qslStatus', selected[0]);
                }}
              >
                <DropdownItem key="">全部状态</DropdownItem>
                <DropdownItem key="confirmed">已确认</DropdownItem>
                <DropdownItem key="uploaded">已上传未确认</DropdownItem>
                <DropdownItem key="none">未上传</DropdownItem>
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
                <span className="hidden md:inline">清除筛选</span>
                <span className="md:hidden">清除</span>
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
                    <span className="hidden lg:inline">WaveLog同步</span>
                    <span className="lg:hidden hidden md:inline">同步</span>
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label="WaveLog同步操作"
                  onAction={(key) => handleWaveLogSync(key as 'download' | 'upload' | 'full_sync')}
                >
                  <DropdownItem
                    key="download"
                    startContent={<FontAwesomeIcon icon={faDownload} className="text-primary" />}
                    description="从WaveLog下载最新的QSO记录"
                  >
                    下载同步
                  </DropdownItem>
                  <DropdownItem
                    key="upload"
                    startContent={<FontAwesomeIcon icon={faUpload} className="text-secondary" />}
                    description="上传本地QSO记录到WaveLog"
                  >
                    上传同步
                  </DropdownItem>
                  <DropdownItem
                    key="full_sync"
                    startContent={<FontAwesomeIcon icon={faSync} className="text-warning" />}
                    description="双向完整同步"
                  >
                    完整同步
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
                  aria-label="QRZ.com同步操作"
                  onAction={(key) => handleQRZSync(key as 'download' | 'upload' | 'full_sync')}
                >
                  <DropdownItem
                    key="download"
                    startContent={<FontAwesomeIcon icon={faDownload} className="text-primary" />}
                    description="从QRZ.com Logbook下载QSO记录"
                  >
                    从 QRZ.com 下载
                  </DropdownItem>
                  <DropdownItem
                    key="upload"
                    startContent={<FontAwesomeIcon icon={faUpload} className="text-secondary" />}
                    description="上传本地QSO记录到QRZ.com Logbook"
                  >
                    上传到 QRZ.com
                  </DropdownItem>
                  <DropdownItem
                    key="full_sync"
                    startContent={<FontAwesomeIcon icon={faSync} className="text-warning" />}
                    description="双向完整同步"
                  >
                    完整同步
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
                  aria-label="LoTW同步操作"
                  onAction={(key) => handleLoTWSync(key as 'upload' | 'download_confirmations')}
                >
                  <DropdownItem
                    key="download_confirmations"
                    startContent={<FontAwesomeIcon icon={faDownload} className="text-primary" />}
                    description="从LoTW下载QSL确认记录"
                  >
                    下载 LoTW 确认
                  </DropdownItem>
                  <DropdownItem
                    key="upload"
                    startContent={<FontAwesomeIcon icon={faUpload} className="text-secondary" />}
                    description="通过本地TQSL工具签名上传到LoTW"
                  >
                    上传到 LoTW
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
                  <span className="hidden md:inline">导出</span>
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="导出格式"
                onAction={(key) => handleExport(key as 'adif' | 'csv')}
              >
                <DropdownItem key="adif">ADIF 格式</DropdownItem>
                <DropdownItem key="csv">CSV 格式</DropdownItem>
              </DropdownMenu>
            </Dropdown>

            {/* 打开日志文件目录按钮 - 仅Electron */}
            {isElectron() && (
              <Tooltip content="在文件管理器中打开日志文件目录">
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
              <Tooltip content="配置同步服务">
                <Button
                  variant="flat"
                  size="sm"
                  isIconOnly
                  onPress={() => setIsSyncConfigOpen(true)}
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
              ? `筛选结果: ${totalRecords} 条 / 总计: ${actualTotalRecords} 条通联记录`
              : `共 ${actualTotalRecords} 条通联记录`
            }
          </span>
          {statistics && (
            <span className="flex flex-wrap gap-2 md:gap-0">
              <span>唯一呼号: {statistics.uniqueCallsigns}</span>
              {statistics.lastQSO && (
                <span className="hidden md:inline"> | 最近通联: {new Date(statistics.lastQSO).toLocaleDateString('zh-CN', { timeZone: 'UTC' })} UTC</span>
              )}
            </span>
          )}
        </div>
      </div>
    );
  }, [
    operatorCallsign,
    isSearchExpanded,
    filters.callsign,
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
    isSyncConfigOpen,
    handleQRZSync,
    handleLoTWSync
  ]);

  // 底部内容：分页
  const bottomContent = React.useMemo(() => {
    console.log('📊 [LogbookViewer] 渲染分页组件:', { 
      currentPage, 
      totalPages, 
      showPagination: totalPages > 1 
    });
    
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
            console.log('📊 [LogbookViewer] 分页切换:', { from: currentPage, to: page });
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
              console.log('📊 [LogbookViewer] 跳转到第一页');
              setCurrentPage(1);
            }}
            isDisabled={currentPage === 1 || totalPages <= 1}
            className="min-w-0 text-xs md:text-sm"
          >
            <span className="hidden md:inline">第一页</span>
            <span className="md:hidden">首页</span>
          </Button>
          <Button
            size="sm"
            variant="flat"
            onPress={() => {
              console.log('📊 [LogbookViewer] 跳转到最后页:', totalPages);
              setCurrentPage(totalPages);
            }}
            isDisabled={currentPage === totalPages || totalPages <= 1}
            className="min-w-0 text-xs md:text-sm"
          >
            <span className="hidden md:inline">最后页</span>
            <span className="md:hidden">尾页</span>
          </Button>
        </div>
      </div>
    );
  }, [currentPage, totalPages]);

  // 计算加载状态的内容
  const loadingState = loading ? "loading" : "idle";

  // 如果有错误，显示错误信息
  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6 max-w-7xl mx-auto">
        <Alert
          color="danger"
          title="加载失败"
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
              重试
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
          title="WaveLog同步成功"
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
          title="WaveLog同步失败"
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
          title="QRZ.com 同步成功"
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
          title="QRZ.com 同步失败"
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
          title="LoTW 同步成功"
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
          title="LoTW 同步失败"
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
          title="导出失败"
          description={exportError}
          isClosable
          onClose={() => setExportError(null)}
        />
      )}

      {/* 表格 - 固定高度 */}
      <Table
        aria-label="QSO记录表格"
        isHeaderSticky
        bottomContent={bottomContent}
        bottomContentPlacement="outside"
        classNames={{
          wrapper: "max-h-[calc(100vh-280px)] md:max-h-[calc(100vh-228px)] overflow-auto",
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
          emptyContent={"暂无通联记录"}
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
      <Modal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingQSO(null);
          setEditFormData({});
        }}
        size="2xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader>
            <h3 className="text-lg font-semibold">编辑 QSO 记录</h3>
          </ModalHeader>
          <ModalBody>
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="呼号"
                  value={editFormData.callsign || ''}
                  onChange={(e) => setEditFormData({ ...editFormData, callsign: e.target.value })}
                  isRequired
                />
                <Input
                  label="网格坐标"
                  value={editFormData.grid || ''}
                  onChange={(e) => setEditFormData({ ...editFormData, grid: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="频率 (Hz)"
                  type="number"
                  value={editFormData.frequency?.toString() || ''}
                  onChange={(e) => setEditFormData({ ...editFormData, frequency: parseInt(e.target.value) || 0 })}
                  isRequired
                />
                <Select
                  label="模式"
                  selectedKeys={editFormData.mode ? [editFormData.mode] : []}
                  onSelectionChange={(keys) => {
                    const selected = Array.from(keys as Set<string>)[0];
                    setEditFormData({ ...editFormData, mode: selected as string });
                  }}
                  isRequired
                >
                  <SelectItem key="FT8">FT8</SelectItem>
                  <SelectItem key="FT4">FT4</SelectItem>
                  <SelectItem key="RTTY">RTTY</SelectItem>
                  <SelectItem key="CW">CW</SelectItem>
                  <SelectItem key="SSB">SSB</SelectItem>
                </Select>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="发送信号报告"
                  value={editFormData.reportSent || ''}
                  onChange={(e) => setEditFormData({ ...editFormData, reportSent: e.target.value })}
                />
                <Input
                  label="接收信号报告"
                  value={editFormData.reportReceived || ''}
                  onChange={(e) => setEditFormData({ ...editFormData, reportReceived: e.target.value })}
                />
              </div>

              {/* 分隔线 + QSL 确认状态 */}
              <div className="border-t border-default-200 dark:border-default-100 pt-4">
                <p className="text-sm font-medium text-default-500 mb-3">确认状态</p>
                <div className="grid grid-cols-2 gap-4">
                  {/* LoTW */}
                  <div className="flex items-center justify-between rounded-lg bg-default-50 dark:bg-default-100/5 px-3.5 py-2.5">
                    <span className="text-sm font-medium text-default-600">LoTW</span>
                    <div className="flex items-center gap-4">
                      <Checkbox
                        size="sm"
                        isSelected={editFormData.lotwQslSent === 'Y'}
                        onValueChange={(checked) =>
                          setEditFormData({ ...editFormData, lotwQslSent: checked ? 'Y' : 'N' })
                        }
                        color="primary"
                      >
                        <span className="text-sm">已上传</span>
                      </Checkbox>
                      <Checkbox
                        size="sm"
                        isSelected={editFormData.lotwQslReceived === 'Y' || editFormData.lotwQslReceived === 'V'}
                        onValueChange={(checked) =>
                          setEditFormData({ ...editFormData, lotwQslReceived: checked ? 'Y' : 'N' })
                        }
                        color="success"
                      >
                        <span className="text-sm">已确认</span>
                      </Checkbox>
                    </div>
                  </div>
                  {/* QRZ */}
                  <div className="flex items-center justify-between rounded-lg bg-default-50 dark:bg-default-100/5 px-3.5 py-2.5">
                    <span className="text-sm font-medium text-default-600">QRZ</span>
                    <div className="flex items-center gap-4">
                      <Checkbox
                        size="sm"
                        isSelected={editFormData.qrzQslSent === 'Y'}
                        onValueChange={(checked) =>
                          setEditFormData({ ...editFormData, qrzQslSent: checked ? 'Y' : 'N' })
                        }
                        color="primary"
                      >
                        <span className="text-sm">已上传</span>
                      </Checkbox>
                      <Checkbox
                        size="sm"
                        isSelected={editFormData.qrzQslReceived === 'Y'}
                        onValueChange={(checked) =>
                          setEditFormData({ ...editFormData, qrzQslReceived: checked ? 'Y' : 'N' })
                        }
                        color="success"
                      >
                        <span className="text-sm">已确认</span>
                      </Checkbox>
                    </div>
                  </div>
                </div>
              </div>

              <Alert color="warning" variant="flat" className="text-sm">
                修改 QSO 记录可能会影响统计数据的准确性，请谨慎操作。
              </Alert>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={() => {
                setIsEditModalOpen(false);
                setEditingQSO(null);
                setEditFormData({});
              }}
            >
              取消
            </Button>
            <Button
              color="primary"
              onPress={handleEditSave}
              isLoading={isEditSaving}
              isDisabled={!editFormData.callsign || !editFormData.frequency}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

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
            <h3 className="text-lg font-semibold text-danger">删除 QSO 记录</h3>
          </ModalHeader>
          <ModalBody>
            {deletingQSO && (
              <div className="space-y-3">
                <p className="text-default-600">
                  确定要删除与 <span className="font-semibold text-danger">{deletingQSO.callsign}</span> 的通联记录吗?
                </p>
                <div className="p-3 bg-default-100 rounded-lg space-y-1">
                  <p className="text-sm"><span className="font-medium">时间:</span> {formatDateTime(deletingQSO.startTime)}</p>
                  <p className="text-sm"><span className="font-medium">频率:</span> {formatFrequency(deletingQSO.frequency)}</p>
                  <p className="text-sm"><span className="font-medium">模式:</span> {deletingQSO.mode}</p>
                </div>
                <div className="p-3 bg-danger-50 dark:bg-danger-100/20 border border-danger-200 dark:border-danger-400/30 rounded-lg">
                  <p className="text-danger-700 dark:text-danger-400 text-sm">
                    ⚠️ 此操作无法撤销,删除后该记录将永久丢失。
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
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteConfirm}
              isLoading={isDeleting}
            >
              确认删除
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
          onSaved={() => {
            // 刷新同步摘要
            api.getCallsignSyncSummary(operatorCallsign).then((res: unknown) => {
              const result = res as { success?: boolean; summary?: { wavelog: boolean; qrz: boolean; lotw: boolean } };
              if (result.success && result.summary) {
                setSyncSummary(result.summary);
                setIsQRZEnabled(result.summary.qrz);
                setIsLoTWEnabled(result.summary.lotw);
              }
            }).catch(() => {});
          }}
        />
      )}
    </div>
  );
};

export default LogbookViewer;
