/**
 * 错误建议展示对话框
 *
 * 用于展示完整的错误信息、操作建议和技术详情
 *
 * @module ErrorSuggestionsDialog
 */

import React, { useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Divider,
  Accordion,
  AccordionItem,
  Code
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faExclamationTriangle,
  faExclamationCircle,
  faInfoCircle,
  faCopy,
  faCheck
} from '@fortawesome/free-solid-svg-icons';

/**
 * 错误信息接口
 */
export interface ErrorInfo {
  /** 用户友好的错误提示 */
  userMessage: string;

  /** 操作建议列表 */
  suggestions?: string[];

  /** 错误代码 */
  code?: string;

  /** 错误严重程度 */
  severity?: 'info' | 'warning' | 'error' | 'critical';

  /** 技术错误信息 */
  technicalDetails?: string;

  /** 错误上下文 */
  context?: Record<string, any>;

  /** 错误时间戳 */
  timestamp?: string;
}

interface ErrorSuggestionsDialogProps {
  /** 是否打开对话框 */
  isOpen: boolean;

  /** 关闭回调 */
  onClose: () => void;

  /** 错误信息 */
  errorInfo: ErrorInfo | null;
}

/**
 * 错误建议展示对话框组件
 */
export function ErrorSuggestionsDialog({
  isOpen,
  onClose,
  errorInfo
}: ErrorSuggestionsDialogProps) {
  const [isCopied, setIsCopied] = useState(false);

  if (!errorInfo) {
    return null;
  }

  const {
    userMessage,
    suggestions = [],
    code,
    severity = 'error',
    technicalDetails,
    context,
    timestamp
  } = errorInfo;

  /**
   * 复制错误信息到剪贴板
   */
  const handleCopy = async () => {
    const errorText = [
      `错误代码: ${code || '未知'}`,
      `严重程度: ${severity}`,
      `时间: ${timestamp || new Date().toISOString()}`,
      ``,
      `用户提示: ${userMessage}`,
      ``,
      ...(suggestions.length > 0
        ? [
            `操作建议:`,
            ...suggestions.map((s, i) => `${i + 1}. ${s}`),
            ``
          ]
        : []),
      ...(technicalDetails ? [`技术详情: ${technicalDetails}`, ``] : []),
      ...(context ? [`上下文:\n${JSON.stringify(context, null, 2)}`] : [])
    ].join('\n');

    try {
      await navigator.clipboard.writeText(errorText);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      console.error('复制失败:', error);
    }
  };

  /**
   * 获取错误图标
   */
  const getIcon = () => {
    switch (severity) {
      case 'critical':
      case 'error':
        return faExclamationTriangle;
      case 'warning':
        return faExclamationCircle;
      case 'info':
        return faInfoCircle;
      default:
        return faExclamationCircle;
    }
  };

  /**
   * 获取错误标题颜色
   */
  const getTitleColor = () => {
    switch (severity) {
      case 'critical':
      case 'error':
        return 'text-danger';
      case 'warning':
        return 'text-warning';
      case 'info':
        return 'text-primary';
      default:
        return 'text-danger';
    }
  };

  /**
   * 获取错误标题文本
   */
  const getTitleText = () => {
    switch (severity) {
      case 'critical':
        return '严重错误';
      case 'error':
        return '发生错误';
      case 'warning':
        return '警告';
      case 'info':
        return '提示';
      default:
        return '发生错误';
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="2xl"
      scrollBehavior="inside"
      backdrop="blur"
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <FontAwesomeIcon
            icon={getIcon()}
            className={`${getTitleColor()}`}
          />
          <span className={getTitleColor()}>{getTitleText()}</span>
        </ModalHeader>

        <ModalBody>
          {/* 用户友好的错误描述 */}
          <div className="mb-4">
            <p className="text-base">{userMessage}</p>
          </div>

          {/* 操作建议 */}
          {suggestions.length > 0 && (
            <>
              <Divider className="my-3" />
              <div className="mb-4">
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  🔧 操作建议
                </h4>
                <ol className="list-decimal list-inside space-y-1">
                  {suggestions.map((suggestion, index) => (
                    <li key={index} className="text-sm text-default-700">
                      {suggestion}
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}

          {/* 技术信息 */}
          <Divider className="my-3" />
          <div className="mb-4">
            <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
              📋 技术信息
            </h4>
            <div className="space-y-1 text-sm">
              {code && (
                <div className="flex gap-2">
                  <span className="text-default-500">错误代码:</span>
                  <Code color="danger" size="sm">
                    {code}
                  </Code>
                </div>
              )}
              {timestamp && (
                <div className="flex gap-2">
                  <span className="text-default-500">时间:</span>
                  <span className="text-default-700">{timestamp}</span>
                </div>
              )}
              {technicalDetails && (
                <div className="mt-2">
                  <span className="text-default-500 block mb-1">
                    技术详情:
                  </span>
                  <Code className="block w-full" size="sm">
                    {technicalDetails}
                  </Code>
                </div>
              )}
            </div>

            {/* 复制按钮 */}
            <Button
              size="sm"
              color={isCopied ? 'success' : 'default'}
              variant="flat"
              startContent={
                <FontAwesomeIcon icon={isCopied ? faCheck : faCopy} />
              }
              onPress={handleCopy}
              className="mt-3"
            >
              {isCopied ? '已复制' : '复制错误信息'}
            </Button>
          </div>

          {/* 详细上下文（可折叠） */}
          {context && Object.keys(context).length > 0 && (
            <>
              <Divider className="my-3" />
              <Accordion variant="light">
                <AccordionItem
                  key="context"
                  title="详细上下文"
                  className="text-sm"
                >
                  <pre className="text-xs bg-default-100 p-3 rounded-lg overflow-x-auto">
                    {JSON.stringify(context, null, 2)}
                  </pre>
                </AccordionItem>
              </Accordion>
            </>
          )}
        </ModalBody>

        <ModalFooter>
          <Button color="primary" variant="light" onPress={onClose}>
            关闭
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
