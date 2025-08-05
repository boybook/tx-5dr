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
} from '@heroui/react';
import { SearchIcon } from '@heroui/shared-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import type { QSORecord, LogBookStatistics } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useLogbook } from '../store/radioStore';

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
  const [sortDescriptor, setSortDescriptor] = useState<{
    column: string;
    direction: 'ascending' | 'descending';
  }>({ column: 'startTime', direction: 'descending' });
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);

  // 获取操作员连接的日志本
  const effectiveLogBookId = logBookId || 'default';
  
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
      
      const response = await api.getLogBookQSOs(effectiveLogBookId, queryOptions);
      setQsos(response.data);
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

  // 过滤和排序后的数据（性能优化）
  const sortedQsos = useMemo(() => {
    if (qsos.length === 0) return [];
    
    // 使用稳定排序避免不必要的重新渲染
    return [...qsos].sort((a, b) => {
      const column = sortDescriptor.column as keyof QSORecord;
      const aValue = a[column];
      const bValue = b[column];
      
      // 处理空值
      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return sortDescriptor.direction === 'ascending' ? -1 : 1;
      if (bValue == null) return sortDescriptor.direction === 'ascending' ? 1 : -1;
      
      // 字符串比较
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        const result = aValue.localeCompare(bValue);
        return sortDescriptor.direction === 'ascending' ? result : -result;
      }
      
      // 数字比较
      if (typeof aValue === 'number' && typeof bValue === 'number') {
        const result = aValue - bValue;
        return sortDescriptor.direction === 'ascending' ? result : -result;
      }
      
      // 日期比较
      if (column === 'startTime') {
        const result = Number(aValue) - Number(bValue);
        return sortDescriptor.direction === 'ascending' ? result : -result;
      }
      
      return 0;
    });
  }, [qsos, sortDescriptor]);

  // 分页数据（性能优化）
  const paginatedQsos = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return sortedQsos.slice(startIndex, endIndex);
  }, [sortedQsos, currentPage, itemsPerPage]);
  
  // 总页数计算
  const totalPages = useMemo(() => {
    return Math.ceil(qsos.length / itemsPerPage);
  }, [qsos.length, itemsPerPage]);

  // 导出功能（增强错误处理）
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  
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

  // 格式化日期显示
  const formatDateTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // 表格列定义
  const columns = [
    { key: 'startTime', label: '时间', sortable: true },
    { key: 'callsign', label: '呼号', sortable: true },
    { key: 'grid', label: '网格', sortable: true },
    { key: 'frequency', label: '频率 (Hz)', sortable: true },
    { key: 'mode', label: '模式', sortable: true },
    { key: 'reportSent', label: '发送信号报告', sortable: false },
    { key: 'reportReceived', label: '接收信号报告', sortable: false },
  ];

  // 渲染单元格内容
  const renderCell = React.useCallback((qso: QSORecord, columnKey: React.Key) => {
    const cellValue = qso[columnKey as keyof QSORecord];

    switch (columnKey) {
      case "startTime":
        return formatDateTime(qso.startTime);
      case "callsign":
        return (
          <div className="font-semibold">{qso.callsign}</div>
        );
      case "grid":
        return qso.grid ? (
          <Chip size="sm" variant="flat" color="primary">
            {qso.grid}
          </Chip>
        ) : '-';
      case "frequency":
        return qso.frequency ? qso.frequency.toLocaleString() : '-';
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
          <span>共 {qsos.length} 条通联记录</span>
          {statistics && (
            <span>
              唯一呼号: {statistics.uniqueCallsigns}
              {statistics.lastQSO && (
                <> | 最近通联: {new Date(statistics.lastQSO).toLocaleDateString()}</>
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
    qsos.length,
    statistics,
    isExporting,
    handleFilterChange,
    clearFilters,
    handleExport
  ]);

  // 底部内容：分页
  const bottomContent = React.useMemo(() => {
    return (
      <div className="py-2 px-2 flex justify-between items-center">
        <span className="w-[30%] text-small text-default-400">
          {statistics && (
            <>
              总通联: {statistics.totalQSOs} | 唯一呼号: {statistics.uniqueCallsigns}
              {statistics.lastQSO && (
                <> | 最近通联: {new Date(statistics.lastQSO).toLocaleDateString()}</>
              )}
            </>
          )}
        </span>
        <Pagination
          isCompact
          showControls
          showShadow
          color="primary"
          page={currentPage}
          total={totalPages}
          onChange={setCurrentPage}
        />
        <div className="hidden sm:flex w-[30%] justify-end gap-2">
          <Button isDisabled size="sm" variant="flat" onPress={() => setCurrentPage(1)}>
            第一页
          </Button>
          <Button isDisabled size="sm" variant="flat" onPress={() => setCurrentPage(totalPages)}>
            最后页
          </Button>
        </div>
      </div>
    );
  }, [currentPage, totalPages, statistics]);

  // 计算加载状态的内容
  const loadingState = loading ? "loading" : "idle";

  // 如果有错误，显示错误信息
  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
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
    <div className="p-6 pt-4 max-w-7xl mx-auto space-y-6">
      {/* 导出错误提示 */}
      {exportError && (
        <Alert
          color="danger"
          variant="flat"
          className="w-full"
          title="导出失败"
          description={exportError}
          isClosable
          onClose={() => setExportError(null)}
        />
      )}

      {/* QSO记录表格 - 直接使用Table，不包装Card */}
      <Table
        aria-label="QSO记录表格"
        isHeaderSticky
        bottomContent={bottomContent}
        bottomContentPlacement="outside"
        classNames={{
          wrapper: "max-h-[382px]",
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
          items={paginatedQsos}
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
    </div>
  );
};

export default LogbookViewer;