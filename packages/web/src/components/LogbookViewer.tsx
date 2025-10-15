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
  ButtonGroup,
  Select,
  SelectItem,
} from '@heroui/react';
import { SearchIcon } from '@heroui/shared-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faSync, faDownload, faUpload, faExternalLinkAlt, faEdit, faTrash } from '@fortawesome/free-solid-svg-icons';
import type { QSORecord, LogBookStatistics, WaveLogSyncResponse } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useLogbook } from '../store/radioStore';
import { isElectron } from '../utils/config';

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
  
  // 集成实时数据更新
  const { getQSOsForOperator, getStatisticsForLogbook } = useLogbook();
  
  // 监听实时QSO更新
  useEffect(() => {
    const realtimeQsos = getQSOsForOperator(operatorId);
    if (realtimeQsos.length > 0) {
      // 合并实时数据和本地数据，去重
      setQsos(prevQsos => {
        const combinedQsos = [...realtimeQsos, ...prevQsos];
        const uniqueQsos = combinedQsos.filter((qso, index, arr) => 
          arr.findIndex(q => q.id === qso.id) === index
        );
        return uniqueQsos.sort((a, b) => b.startTime - a.startTime);
      });
    }
  }, [operatorId, getQSOsForOperator]);
  
  // 监听实时统计更新
  useEffect(() => {
    const realtimeStats = getStatisticsForLogbook(effectiveLogBookId);
    if (realtimeStats) {
      setStatistics(realtimeStats);
    }
  }, [effectiveLogBookId, getStatisticsForLogbook]);

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

  // 初始加载
  useEffect(() => {
    loadQSOs();
    loadStatistics();
  }, [effectiveLogBookId, filters, currentPage]);

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
      const response = await fetch('/api/wavelog/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operation })
      });
      
      const result = await response.json() as WaveLogSyncResponse;
      
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
      const errorMessage = error instanceof Error ? error.message : 'WaveLog同步失败';
      console.error('WaveLog同步失败:', error);
      setSyncError(errorMessage);
    } finally {
      setIsSyncing(false);
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
      if (typeof window !== 'undefined' && (window as any).electronAPI?.shell?.openExternal) {
        (window as any).electronAPI.shell.openExternal(url);
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
  const formatDateTime = (timestamp: number) => {
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

  // 表格列定义
  const columns = [
    { key: 'startTime', label: '时间 (UTC)', sortable: true },
    { key: 'callsign', label: '呼号', sortable: true },
    { key: 'grid', label: '网格', sortable: true },
    { key: 'frequency', label: '频率', sortable: true },
    { key: 'mode', label: '模式', sortable: true },
    { key: 'reportSent', label: '发送信号报告', sortable: false },
    { key: 'reportReceived', label: '接收信号报告', sortable: false },
    { key: 'actions', label: '操作', sortable: false },
  ];

  // 渲染单元格内容
  const renderCell = React.useCallback((qso: QSORecord, columnKey: React.Key) => {
    const cellValue = qso[columnKey as keyof QSORecord];

    switch (columnKey) {
      case "startTime":
        return formatDateTime(qso.startTime);
      case "callsign":
        return (
          <div className="font-semibold flex items-center gap-2">
            {qso.callsign}
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
        return qso.frequency ? formatFrequency(qso.frequency) : '-';
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
      case "actions":
        return (
          <div className="flex items-center gap-2">
            <Tooltip content="编辑">
              <Button
                size="sm"
                variant="light"
                isIconOnly
                onPress={() => handleEditClick(qso)}
              >
                <FontAwesomeIcon icon={faEdit} className="text-primary" />
              </Button>
            </Tooltip>
            <Tooltip content="删除">
              <Button
                size="sm"
                variant="light"
                color="danger"
                isIconOnly
                onPress={() => handleDeleteClick(qso)}
              >
                <FontAwesomeIcon icon={faTrash} />
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
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-foreground">
              通联日志
            </h1>
            {operatorCallsign && (
              <div className="flex items-center gap-2">
                <span className="text-default-500">-</span>
                <div className="bg-primary-50 dark:bg-primary-100/20 text-primary-600 dark:text-primary-400 px-3 py-1.5 rounded-full text-sm font-mono font-medium">
                  {operatorCallsign}
                </div>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {/* 可展开的搜索框 */}
            {isSearchExpanded ? (
              <Input
                autoFocus
                isClearable
                size="sm"
                className="w-64 transition-all duration-200"
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
                startContent={<SearchIcon />}
                onPress={() => setIsSearchExpanded(true)}
                className="transition-all duration-200"
              >
                搜索
              </Button>
            )}
            
            {/* 筛选按钮 */}
            <Dropdown>
              <DropdownTrigger>
                <Button 
                  variant="flat"
                  size="sm"
                  endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs" />}
                  color={filters.band ? "primary" : "default"}
                >
                  频段{filters.band ? `: ${filters.band}` : ''}
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
                <DropdownItem key="20m">20m</DropdownItem>
                <DropdownItem key="40m">40m</DropdownItem>
                <DropdownItem key="80m">80m</DropdownItem>
              </DropdownMenu>
            </Dropdown>
            
            <Dropdown>
              <DropdownTrigger>
                <Button 
                  variant="flat"
                  size="sm"
                  endContent={<FontAwesomeIcon icon={faChevronDown} className="text-default-400 text-xs" />}
                  color={filters.mode ? "primary" : "default"}
                >
                  模式{filters.mode ? `: ${filters.mode}` : ''}
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
            
            {Object.keys(filters).length > 0 && (
              <Button
                variant="light" 
                color="danger"
                size="sm"
                onPress={clearFilters}
              >
                清除筛选
              </Button>
            )}
            
            {/* WaveLog同步按钮 */}
            <Dropdown>
              <DropdownTrigger>
                <Button
                  color="secondary"
                  variant="bordered"
                  size="sm"
                  isLoading={isSyncing}
                  startContent={<FontAwesomeIcon icon={faSync} className={isSyncing ? 'animate-spin' : ''} />}
                >
                  WaveLog同步
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
            
            <Dropdown>
              <DropdownTrigger>
                <Button
                  color="primary"
                  variant="bordered"
                  size="sm"
                  isLoading={isExporting}
                  disabled={qsos.length === 0}
                >
                  导出
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
          </div>
        </div>

        {/* 统计信息 */}
        <div className="flex justify-between items-center text-small text-default-500">
          <span>
            {hasFilters 
              ? `筛选结果: ${totalRecords} 条 / 总计: ${actualTotalRecords} 条通联记录`
              : `共 ${actualTotalRecords} 条通联记录`
            }
          </span>
          {statistics && (
            <span>
              唯一呼号: {statistics.uniqueCallsigns}
              {statistics.lastQSO && (
                <> | 最近通联: {new Date(statistics.lastQSO).toLocaleDateString('zh-CN', { timeZone: 'UTC' })} UTC</>
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
    totalRecords,
    actualTotalRecords,
    hasFilters,
    statistics,
    isExporting,
    handleFilterChange,
    clearFilters,
    handleExport
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
      <div className="py-2 px-2 flex justify-between items-center">
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
          >
            第一页
          </Button>
          <Button 
            size="sm" 
            variant="flat" 
            onPress={() => {
              console.log('📊 [LogbookViewer] 跳转到最后页:', totalPages);
              setCurrentPage(totalPages);
            }}
            isDisabled={currentPage === totalPages || totalPages <= 1}
          >
            最后页
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
    <div className="p-6 max-w-7xl mx-auto">
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
          wrapper: "max-h-[calc(100vh-228px)] overflow-auto",
        }}
        sortDescriptor={sortDescriptor}
        topContent={topContent}
        topContentPlacement="outside"
        onSortChange={(descriptor) => setSortDescriptor(descriptor as any)}
      >
        <TableHeader columns={columns}>
          {(column) => (
            <TableColumn
              key={column.key}
              allowsSorting={column.sortable}
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
              {(columnKey) => (
                <TableCell>{renderCell(qso, columnKey)}</TableCell>
              )}
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
                    const selected = Array.from(keys)[0];
                    setEditFormData({ ...editFormData, mode: selected as string });
                  }}
                  isRequired
                >
                  <SelectItem key="FT8" value="FT8">FT8</SelectItem>
                  <SelectItem key="FT4" value="FT4">FT4</SelectItem>
                  <SelectItem key="RTTY" value="RTTY">RTTY</SelectItem>
                  <SelectItem key="CW" value="CW">CW</SelectItem>
                  <SelectItem key="SSB" value="SSB">SSB</SelectItem>
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

              <div className="p-3 bg-warning-50 dark:bg-warning-100/20 border border-warning-200 dark:border-warning-400/30 rounded-lg">
                <p className="text-warning-700 dark:text-warning-400 text-sm">
                  ⚠️ 注意:修改 QSO 记录可能会影响统计数据的准确性,请谨慎操作。
                </p>
              </div>
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
    </div>
  );
};

export default LogbookViewer;