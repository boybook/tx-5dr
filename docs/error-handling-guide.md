# TX-5DR 错误处理使用指南

> **版本**: v1.0
> **更新日期**: 2025-11-03
> **适用范围**: @tx5dr/core + @tx5dr/web

## 📋 目录

- [概述](#概述)
- [核心概念](#核心概念)
- [快速开始](#快速开始)
- [API 错误处理](#api-错误处理)
- [WebSocket 错误处理](#websocket-错误处理)
- [错误 Toast 工具](#错误-toast-工具)
- [错误代码处理](#错误代码处理)
- [最佳实践](#最佳实践)
- [常见问题](#常见问题)

---

## 概述

TX-5DR 项目实现了统一的错误处理系统，提供：

✅ **用户友好的错误提示** - 将技术错误转化为易懂的用户消息
✅ **操作建议** - 告诉用户如何解决问题
✅ **严重程度分级** - 根据错误级别提供不同的 UI 反馈
✅ **智能操作按钮** - 自动提供重试、前往设置等快捷操作
✅ **完整的错误信息** - 保留技术详情用于调试

### 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    后端错误发生                          │
└────────────────┬────────────────────────────────────────┘
                 │
                 ├─ HTTP API 错误 → ApiError
                 │    └─ @tx5dr/core/api.ts
                 │
                 └─ WebSocket 错误 → ErrorData
                      └─ radioStore.ts
                 │
                 ↓
┌─────────────────────────────────────────────────────────┐
│              showErrorToast(错误信息)                    │
│         @tx5dr/web/utils/errorToast.tsx                 │
└────────────────┬────────────────────────────────────────┘
                 │
                 ↓
┌─────────────────────────────────────────────────────────┐
│          @heroui/toast 显示用户友好提示                  │
│   - 颜色/图标区分严重程度                                 │
│   - 超时自动关闭（严重错误永不关闭）                       │
│   - 操作按钮（重试/前往设置等）                           │
└─────────────────────────────────────────────────────────┘
```

---

## 核心概念

### 1. 错误格式

#### ErrorData (WebSocket 错误)

```typescript
interface ErrorData {
  message: string;        // 技术错误信息（供开发者/日志）
  userMessage: string;    // 用户友好提示（供 UI 显示）⭐
  code?: string;          // 错误代码 ⭐
  severity?: 'info' | 'warning' | 'error' | 'critical';  // 严重程度 ⭐
  suggestions?: string[]; // 操作建议 ⭐
  timestamp?: number;     // 时间戳
  context?: object;       // 错误上下文
}
```

#### ApiError (HTTP API 错误)

```typescript
class ApiError extends Error {
  code?: string;
  userMessage: string;    // 用户友好提示
  suggestions: string[];  // 操作建议
  severity: 'info' | 'warning' | 'error' | 'critical';
  httpStatus: number;     // HTTP 状态码
  context?: Record<string, any>;
}
```

### 2. 严重程度

| Severity | 含义 | UI 颜色 | 超时时间 | 图标 |
|----------|------|---------|---------|------|
| `critical` | 严重错误，需立即处理 | danger (红色) | 永不关闭 | ⚠️ 严重错误 |
| `error` | 操作失败，影响功能 | danger (橙红) | 10秒 | 错误 |
| `warning` | 潜在问题，不影响核心功能 | warning (黄色) | 5秒 | ⚠️ 警告 |
| `info` | 提示性信息 | primary (蓝色) | 3秒 | 提示 |

---

## 快速开始

### 使用 showErrorToast

```typescript
import { showErrorToast } from '@/utils/errorToast';

// 基本用法
showErrorToast({
  userMessage: '电台启动失败',
  suggestions: ['请检查电台是否开机', '检查 USB 连接'],
  severity: 'error',
  code: 'ENGINE_START_FAILED'
});

// 带操作按钮
showErrorToast({
  userMessage: '连接断开',
  suggestions: ['点击重试按钮重新连接'],
  severity: 'warning',
  action: {
    label: '重试',
    handler: () => reconnect()
  }
});

// 严重错误（不自动关闭）
showErrorToast({
  userMessage: '系统发生严重错误，请重启应用',
  severity: 'critical',
  code: 'SYSTEM_CRASH'
});
```

### 快捷方法

```typescript
import { showInfoToast, showWarningToast, showError, showCriticalError } from '@/utils/errorToast';

// 信息提示
showInfoToast('操作成功');

// 警告
showWarningToast('连接不稳定', ['检查网络质量']);

// 错误
showError('操作失败', ['请重试']);

// 严重错误
showCriticalError('系统崩溃', ['立即重启应用']);
```

---

## API 错误处理

### 后端 API 方法（@tx5dr/core）

所有关键的 API 方法已更新为使用统一的 `apiRequest` 函数：

```typescript
import { api, ApiError } from '@tx5dr/core';

// 示例：获取音频设备
try {
  const devices = await api.getAudioDevices();
  console.log('设备列表:', devices);
} catch (error) {
  if (error instanceof ApiError) {
    // ApiError 包含增强的错误信息
    console.error('错误代码:', error.code);
    console.error('用户提示:', error.userMessage);
    console.error('建议:', error.suggestions);
    console.error('严重程度:', error.severity);
  }
}
```

### 前端组件中处理 API 错误

```typescript
import { api, ApiError } from '@tx5dr/core';
import { showErrorToast } from '@/utils/errorToast';

function MyComponent() {
  const handleConnect = async () => {
    try {
      await api.connectRadio();
      // 成功处理
    } catch (error) {
      if (error instanceof ApiError) {
        // 显示用户友好的错误提示
        showErrorToast({
          userMessage: error.userMessage,
          suggestions: error.suggestions,
          severity: error.severity,
          code: error.code,
          technicalDetails: error.message
        });
      } else {
        // 兜底错误处理
        showErrorToast({
          userMessage: '发生未知错误，请稍后重试',
          severity: 'error'
        });
      }
    }
  };

  return <button onClick={handleConnect}>连接电台</button>;
}
```

### 已更新的 API 方法

以下方法已使用统一的错误处理：

**音频设备 API**:
- `getAudioDevices()` - 获取音频设备列表
- `getAudioSettings()` - 获取音频设置
- `updateAudioSettings()` - 更新音频设置
- `resetAudioSettings()` - 重置音频设置

**电台控制 API**:
- `getRadioConfig()` - 获取电台配置
- `updateRadioConfig()` - 更新电台配置
- `getSupportedRigs()` - 获取支持的电台型号
- `getSerialPorts()` - 获取串口列表
- `testRadio()` - 测试电台连接
- `testPTT()` - 测试 PTT
- `getRadioStatus()` - 获取电台状态
- `connectRadio()` - 连接电台
- `disconnectRadio()` - 断开电台
- `getPresetFrequencies()` - 获取预设频率
- `setRadioFrequency()` - 设置频率

**模式管理 API**:
- `getAvailableModes()` - 获取可用模式
- `getCurrentMode()` - 获取当前模式
- `switchMode()` - 切换模式

**其他方法**: 可参考上述模式自行迁移

---

## WebSocket 错误处理

### radioStore 中的自动处理

`radioStore.ts` 已自动处理所有 WebSocket ERROR 事件，无需在组件中额外处理：

```typescript
// packages/web/src/store/radioStore.ts

error: (data: any) => {
  // 解构增强错误格式
  const { userMessage, suggestions, severity, code, context } = data;

  // 根据错误代码创建操作按钮
  let action;
  if (code === 'CONNECTION_FAILED') {
    action = createRetryConnectionAction(() => {
      // 重试连接逻辑
    });
  }

  // 显示错误 Toast
  showErrorToast({
    userMessage,
    suggestions,
    severity,
    code,
    action  // 智能操作按钮
  });
}
```

### 支持的错误代码操作

| 错误代码 | 操作按钮 | 点击行为 |
|---------|---------|---------|
| `CONNECTION_FAILED` | 重试连接 | 调用 `connectRadio` 命令 |
| `RADIO_CONNECTION_FAILED` | 重试连接 | 调用 `connectRadio` 命令 |
| `ENGINE_START_FAILED` | 重试 | 调用 `startDecoding()` |
| `STATE_CONFLICT` | 刷新状态 | 调用 `getSystemStatus()` |
| `RESOURCE_BUSY` | 重试 | 显示"请稍后再试"提示 |
| `TIMEOUT` | 重试 | 显示"请手动重试"提示 |

---

## 错误 Toast 工具

### showErrorToast API

```typescript
function showErrorToast(options: ErrorToastOptions): void

interface ErrorToastOptions {
  userMessage: string;           // 必需：用户友好提示
  suggestions?: string[];        // 可选：操作建议列表
  severity?: 'info' | 'warning' | 'error' | 'critical';  // 可选：严重程度
  code?: string;                 // 可选：错误代码
  action?: {                     // 可选：操作按钮
    label: string;
    handler: () => void;
  };
  technicalDetails?: string;     // 可选：技术详情（仅开发环境显示）
  context?: Record<string, any>; // 可选：错误上下文
}
```

### 创建操作按钮辅助函数

```typescript
import {
  createRetryConnectionAction,
  createGoToSettingsAction,
  createRefreshStatusAction,
  createRetryAction
} from '@/utils/errorToast';

// 重试连接
const retryAction = createRetryConnectionAction(() => {
  console.log('重试连接...');
  reconnect();
});

// 前往设置（需要 navigate 函数）
const settingsAction = createGoToSettingsAction(navigate, 'radio');

// 刷新状态
const refreshAction = createRefreshStatusAction(() => {
  getSystemStatus();
});

// 通用重试
const generalRetryAction = createRetryAction(() => {
  retryLastOperation();
});
```

---

## 错误代码处理

### 错误代码类型

```typescript
type ErrorCode =
  | 'CONNECTION_FAILED'      // 连接失败
  | 'DEVICE_NOT_FOUND'       // 设备未找到
  | 'CONFIG_ERROR'           // 配置错误
  | 'INVALID_FREQUENCY'      // 无效频率
  | 'INVALID_MODE'           // 无效模式
  | 'STATE_CONFLICT'         // 状态冲突
  | 'RESOURCE_BUSY'          // 资源繁忙
  | 'TIMEOUT'                // 超时
  | 'RADIO_DISCONNECTED'     // 电台断开
  | 'ENGINE_START_FAILED'    // 引擎启动失败
  | string;
```

### 判断错误是否可重试

```typescript
import { isRetryableError } from '@/utils/errorToast';

if (isRetryableError(errorCode)) {
  // 显示重试按钮
}
```

### 判断是否需要前往设置

```typescript
import { needsSettingsAction } from '@/utils/errorToast';

if (needsSettingsAction(errorCode)) {
  // 显示"前往设置"按钮
}
```

---

## 最佳实践

### 1. 优先使用 showErrorToast

❌ **不推荐**:
```typescript
toast.error('操作失败');
```

✅ **推荐**:
```typescript
showErrorToast({
  userMessage: '操作失败，请稍后重试',
  severity: 'error'
});
```

### 2. 始终提供建议

❌ **不推荐**:
```typescript
showErrorToast({
  userMessage: '电台连接失败'
});
```

✅ **推荐**:
```typescript
showErrorToast({
  userMessage: '电台连接失败',
  suggestions: [
    '检查电台是否开机',
    '检查 USB 连接',
    '确认电台型号配置正确'
  ]
});
```

### 3. 根据严重程度设置 severity

```typescript
// 信息提示
showErrorToast({ userMessage: '设置已保存', severity: 'info' });

// 警告
showErrorToast({ userMessage: '连接不稳定', severity: 'warning' });

// 错误
showErrorToast({ userMessage: '操作失败', severity: 'error' });

// 严重错误（需要用户立即处理）
showErrorToast({ userMessage: '系统崩溃', severity: 'critical' });
```

### 4. 捕获 API 错误

```typescript
try {
  await api.someMethod();
} catch (error) {
  if (error instanceof ApiError) {
    // 使用 ApiError 的增强信息
    showErrorToast({
      userMessage: error.userMessage,
      suggestions: error.suggestions,
      severity: error.severity,
      code: error.code
    });
  } else {
    // 兜底处理
    showErrorToast({
      userMessage: '发生未知错误',
      severity: 'error'
    });
  }
}
```

### 5. 提供操作按钮

```typescript
showErrorToast({
  userMessage: '连接断开',
  suggestions: ['点击重试按钮重新连接'],
  severity: 'warning',
  action: {
    label: '重试',
    handler: async () => {
      try {
        await reconnect();
        showInfoToast('重新连接成功');
      } catch (e) {
        showError('重新连接失败');
      }
    }
  }
});
```

---

## 常见问题

### Q1: 如何为新的 API 方法添加错误处理？

参考已更新的方法，使用 `apiRequest` 函数：

```typescript
// 旧方式
async myNewMethod(apiBase?: string): Promise<Response> {
  const res = await fetch(`${baseUrl}/my-endpoint`);
  if (!res.ok) {
    throw new Error(`失败: ${res.status}`);
  }
  return await res.json();
}

// 新方式
async myNewMethod(apiBase?: string): Promise<Response> {
  return apiRequest<Response>('/my-endpoint', undefined, apiBase);
}
```

### Q2: 如何添加新的错误代码处理？

在 `radioStore.ts` 的 `error` 事件处理器中添加：

```typescript
// 在 radioStore.ts 中
if (code === 'MY_NEW_ERROR_CODE') {
  action = createRetryAction(() => {
    // 处理逻辑
  });
}
```

### Q3: Toast 不显示怎么办？

检查：
1. 是否正确导入 `showErrorToast`
2. 是否在组件树中包含 `ToastProvider`（通常在 `main.tsx` 中）
3. 浏览器控制台是否有错误

### Q4: 如何自定义 Toast 样式？

修改 `packages/web/src/utils/errorToast.tsx` 中的颜色映射：

```typescript
const colorMap: Record<string, 'primary' | 'warning' | 'danger'> = {
  info: 'primary',
  warning: 'warning',
  error: 'danger',
  critical: 'danger'
};
```

### Q5: 如何显示错误详情对话框？

使用 `ErrorSuggestionsDialog` 组件（计划中）：

```typescript
import { ErrorSuggestionsDialog } from '@/components/ErrorSuggestionsDialog';

<ErrorSuggestionsDialog
  isOpen={isOpen}
  onClose={() => setIsOpen(false)}
  errorInfo={{
    userMessage: '详细错误信息',
    suggestions: ['建议1', '建议2'],
    code: 'ERROR_CODE',
    severity: 'error',
    technicalDetails: '技术详情',
    context: { ... }
  }}
/>
```

---

## 参考资料

- **实施计划文档**: `docs/frontend-integration-implementation.md`
- **架构设计文档**: `docs/architecture-refactor-design.md`
- **前端 CLAUDE.md**: `packages/web/CLAUDE.md`
- **Core CLAUDE.md**: `packages/core/CLAUDE.md`

---

## 更新日志

### v1.0 (2025-11-03)
- ✅ 初始版本
- ✅ 完整的错误处理系统文档
- ✅ API 使用示例
- ✅ WebSocket 错误处理说明
- ✅ 最佳实践指南
