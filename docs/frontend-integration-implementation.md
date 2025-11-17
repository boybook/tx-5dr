# TX-5DR 前端架构适配实施计划

> **文档版本**：v1.1
> **创建日期**：2025-11-03
> **最后更新**：2025-11-03
> **适配范围**：完整方案（P0+P1+P2）
> **预计工作量**：20-24小时
>
> **更新说明**：
> - v1.1：补充 @heroui/toast 使用指南，添加 P0 阶段完整实现代码
> - v1.0：初始版本

---

## 📋 目录

- [项目背景](#项目背景)
- [后端架构变化总结](#后端架构变化总结)
- [前端适配概览](#前端适配概览)
- [阶段1：P0 必须调整](#阶段1p0-必须调整)
- [阶段2：P1 推荐调整](#阶段2p1-推荐调整)
- [阶段3：P2 代码质量优化](#阶段3p2-代码质量优化)
- [实施检查清单](#实施检查清单)
- [测试验收标准](#测试验收标准)
- [常见问题和注意事项](#常见问题和注意事项)

---

## 项目背景

### 重构的根本原因

TX-5DR 数字电台项目经历了严重的系统稳定性问题（P0级别）：

1. **系统崩溃**：电台连接失败导致整个系统进入"僵尸状态"
   - 音频流继续运行但引擎显示未启动
   - 用户无法正常操作，只能重启应用

2. **资源泄漏**：多处事件监听器未正确清理
   - RadioOperatorManager 事件监听器泄漏
   - WSConnection WebSocket 监听器泄漏
   - DigitalRadioEngine 多个 RadioManager 事件监听器未清理

3. **状态不一致**：前后端状态同步问题
   - 电台断开后引擎未自动停止
   - 错误状态无法正确传达给前端

4. **维护困难**：事件链过长（4-5层），难以调试

### 重构的核心目标

**功能目标**：
- 修复内存泄漏问题
- 电台连接失败时 server 不崩溃，正确清理资源
- 首次连接失败能自动重连
- 前后端状态实时同步，错误信息清晰传达
- 电台断开时引擎自动停止

**架构目标**：
- 混合架构：状态机 + 事件系统
- 分层清晰：表示层 → 应用层 → 领域层 → 基础设施层
- 易于测试和扩展
- **API 兼容性**：保持现有 WebSocket 消息格式和事件接口

### 设计原则（最小侵入）

1. **最小侵入**：保持现有 EventEmitter 架构，状态机作为协调层
2. **双轨并行**：事件系统负责数据流/通知，状态机负责生命周期
3. **Manager 为主**：Manager 保持现有状态管理
4. **性能优先**：高频事件完全绕过状态机
5. **渐进增强**：分阶段实施，降低风险

---

## 后端架构变化总结

### 已完成的重构（Day 0-14）

#### 1. XState 状态机（✅ 完成）

**新增组件**：
- `engineStateMachine`：管理引擎生命周期
  - 状态：idle → starting → running → stopping → idle
- `radioStateMachine`：管理电台连接状态
  - 状态：disconnected → connecting → connected
  - 支持自动重连

**架构关系**：
```
状态机（协调层）订阅 Manager 事件
  ↓
触发状态转换
  ↓
发送兼容 WebSocket 事件（前端无感知）
```

#### 2. ResourceManager（✅ 完成）

**职责**：统一管理 9 个资源的启动/停止

**管理的资源**：
1. PhysicalRadioManager（物理电台）
2. IcomAudioAdapter（可选）
3. AudioInputStream（音频输入流）
4. AudioOutputStream（音频输出流）
5. AudioMonitorService（音频监听服务）
6. SlotClock（时钟）
7. DecoderScheduler（解码调度器）
8. SpectrumScheduler（频谱调度器）
9. RadioOperatorManager（操作员管理器）

**优势**：
- 按优先级和依赖关系顺序启动
- 启动失败自动回滚已启动的资源
- 代码从 100+ 行简化到 20 行

#### 3. IRadioConnection 统一接口（✅ 完成）

**新增接口**：`IRadioConnection`

**实现类**：
- `IcomWlanConnection`：ICOM WLAN 连接
- `HamlibConnection`：Hamlib 连接

**工厂**：`RadioConnectionFactory.create(config)`

**效果**：
- PhysicalRadioManager 从直接管理连接 → 编排器
- 代码从 1021 行减少到 820 行（减少 20%）

#### 4. 增强的错误处理（✅ 完成）⭐ **前端需适配**

**新增错误响应格式**：

```typescript
interface ErrorData {
  message: string;        // 技术错误信息（供开发者/日志）
  userMessage: string;    // ⭐ 用户友好提示（供UI显示）
  code: RadioErrorCode;   // ⭐ 标准错误代码
  severity: 'critical' | 'error' | 'warning' | 'info'; // ⭐ 错误严重程度
  suggestions: string[];  // ⭐ 操作建议
  timestamp: number;
  context?: object;       // 错误上下文（可选）
}
```

**WebSocket ERROR 事件**：
```typescript
{
  type: 'error',
  data: ErrorData  // 新格式
}
```

**HTTP API 错误响应**：
```typescript
{
  success: false,
  error: ErrorData  // 新格式
}
```

**HTTP 状态码映射**：
- 400 Bad Request：配置/操作错误
- 404 Not Found：设备未找到
- 409 Conflict：状态冲突
- 500 Internal Server Error：服务器错误
- 503 Service Unavailable：服务不可用

#### 5. EventBus 事件链优化（✅ 完成）

**优化效果**：
- 高频事件（meterData、spectrumData）：5层 → 2层
- operatorStatusUpdate 去重：减少 70-80% 冗余事件

#### 6. 内存泄漏全面修复（✅ 完成）

**修复位置**：
- RadioOperatorManager
- WSConnection
- DigitalRadioEngine
- 其他事件监听器

**新增工具**：
- `MemoryLeakDetector`：开发环境自动检测内存泄漏

---

## 前端适配概览

### 为什么需要前端适配？

虽然后端保持了 API 兼容性，但为了充分利用新的错误处理系统，前端需要进行相应的调整：

1. **新增字段**：`userMessage`、`suggestions`、`severity`、`code`
2. **更好的用户体验**：显示友好的错误提示和操作建议
3. **更清晰的错误区分**：根据严重程度采取不同的 UI 策略

### 兼容性保证

✅ **向后兼容**：
- 旧字段（`message`）仍然存在
- 前端不调整也能正常工作
- 可以渐进式升级

### 适配方案对比

| 方案 | P0 必须 | P1 推荐 | P2 优化 | 工作量 | 用户体验提升 |
|------|---------|---------|---------|--------|-------------|
| **最小化方案** | ✅ | ❌ | ❌ | 4-6h | ⭐⭐⭐ |
| **推荐方案** | ✅ | ✅ | ❌ | 12-16h | ⭐⭐⭐⭐ |
| **完整方案** | ✅ | ✅ | ✅ | 20-24h | ⭐⭐⭐⭐⭐ |

**本文档采用：完整方案**

---

## Toast 组件使用指南

### 当前使用的 Toast 库

项目使用 **@heroui/toast** (v2.0.12)，这是 HeroUI 官方的 Toast 通知组件库，基于 React Aria 和 Framer Motion。

**全局配置**（`packages/web/src/main.tsx`）：
```typescript
import { ToastProvider } from '@heroui/toast';

<ToastProvider placement="top-center" toastOffset={60} />
```

### addToast API 接口

```typescript
import { addToast } from '@heroui/toast';

addToast({
  // 内容
  title: ReactNode,                    // Toast 标题（必需）
  description?: ReactNode,             // 描述内容（可选，支持JSX）

  // 样式
  color?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger',
  severity?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger',
  variant?: 'flat' | 'solid' | 'bordered',
  size?: 'sm' | 'md' | 'lg',

  // 行为
  timeout?: number | undefined,        // 毫秒，undefined 表示永不自动关闭
  hideCloseButton?: boolean,           // 是否隐藏关闭按钮
  onClose?: () => void,                // 关闭回调

  // 自定义
  icon?: ReactNode,                    // 自定义图标
  endContent?: ReactNode,              // 右侧额外内容（用于 Action 按钮）
  classNames?: {...},                  // 精细样式控制
});
```

### 错误处理能力评估

| 需求 | 支持情况 | 实现方式 |
|------|---------|---------|
| 显示 userMessage | ✅ | `title` + `description` |
| 显示 suggestions 列表 | ✅ | `description` 中使用 `\n` 或 JSX |
| 严重程度区分 | ✅ | `color`: `danger`/`warning`/`success`/`primary` |
| Critical 不自动消失 | ✅ | `timeout: undefined` |
| Action 按钮 | ✅ | `endContent` 参数 |
| 自定义图标 | ✅ | `icon` 参数 |

### 现有使用示例

```typescript
// 1. 简单错误提示（radioStore.ts:535）
addToast({
  title: '连接失败',
  description: tips.join('\n'),  // 多行文本用 \n 分隔
});

// 2. 成功提示（RadioControl.tsx:966）
addToast({
  title: '频率切换成功',
  description: `已切换到 ${formatFrequencyDisplay(frequency)} MHz`,
  color: 'success',
  timeout: 3000
});

// 3. 长时间显示（RadioControl.tsx:179）
addToast({
  title: '⚠️ 电台发射中断连接',
  description: data.message,
  timeout: 10000  // 10秒
});

// 4. 永不自动关闭（用于 critical 错误）
addToast({
  title: '严重错误',
  description: '系统出现严重错误，请检查日志',
  color: 'danger',
  timeout: undefined  // 永不自动关闭
});
```

### 推荐的错误处理封装

为了统一错误处理，建议创建 `packages/web/src/utils/errorToast.ts`：

```typescript
import { addToast } from '@heroui/toast';
import { Button } from '@heroui/react';

export interface ErrorToastOptions {
  userMessage: string;
  suggestions?: string[];
  severity?: 'info' | 'warning' | 'error' | 'critical';
  code?: string;
  action?: {
    label: string;
    handler: () => void;
  };
  technicalDetails?: string;
}

export function showErrorToast(options: ErrorToastOptions) {
  // 构建描述（userMessage + suggestions）
  let description = options.userMessage;

  if (options.suggestions && options.suggestions.length > 0) {
    const suggestionText = options.suggestions.map(s => `• ${s}`).join('\n');
    description += '\n\n建议：\n' + suggestionText;
  }

  // 开发环境显示技术详情
  if (import.meta.env.DEV && options.technicalDetails) {
    description += '\n\n[DEV] ' + options.technicalDetails;
  }

  // 映射 severity 到 color
  const colorMap = {
    info: 'primary' as const,
    warning: 'warning' as const,
    error: 'danger' as const,
    critical: 'danger' as const
  };

  const color = colorMap[options.severity || 'error'];

  // Critical 错误永不自动关闭，其他错误 10 秒
  const timeout = options.severity === 'critical' ? undefined : 10000;

  // 构建 Action 按钮
  const endContent = options.action ? (
    <Button
      size="sm"
      color="primary"
      variant="flat"
      onPress={options.action.handler}
    >
      {options.action.label}
    </Button>
  ) : undefined;

  // 标题
  const title = options.severity === 'critical' ? '⚠️ 严重错误' : '错误';

  // 记录技术日志
  console.error('[错误]', {
    code: options.code,
    userMessage: options.userMessage,
    severity: options.severity,
    technicalDetails: options.technicalDetails
  });

  addToast({
    title,
    description,
    color,
    timeout,
    endContent,
    hideCloseButton: false
  });
}

// 便捷函数
export function showSuccessToast(message: string) {
  addToast({
    title: '成功',
    description: message,
    color: 'success',
    timeout: 3000
  });
}

export function showWarningToast(message: string) {
  addToast({
    title: '警告',
    description: message,
    color: 'warning',
    timeout: 5000
  });
}

export function showInfoToast(message: string) {
  addToast({
    title: '提示',
    description: message,
    color: 'primary',
    timeout: 3000
  });
}
```

### 使用封装后的示例

```typescript
import { showErrorToast } from '@/utils/errorToast';

// 1. 简单错误
showErrorToast({
  userMessage: '无法连接到电台',
  suggestions: ['检查电台IP地址', '确认网络连接'],
  severity: 'error',
  code: 'CONNECTION_FAILED'
});

// 2. Critical 错误（不自动消失）
showErrorToast({
  userMessage: '引擎启动失败',
  suggestions: ['重启应用', '检查系统日志'],
  severity: 'critical',
  code: 'ENGINE_START_FAILED',
  technicalDetails: error.message
});

// 3. 带 Action 按钮
showErrorToast({
  userMessage: '电台连接失败',
  suggestions: ['检查设置', '重试连接'],
  severity: 'error',
  code: 'RADIO_TIMEOUT',
  action: {
    label: '重试',
    handler: () => reconnect()
  }
});
```

---

## 阶段1：P0 必须调整

> **优先级**：🔥 最高
> **预计工作量**：4-6 小时
> **目标**：确保用户能看到友好的错误提示

### 任务 1.1：更新 WebSocket ERROR 事件处理器

#### 目标
适配新的错误消息格式，显示用户友好的错误提示和操作建议。

#### 涉及文件
- **主要修改**：`packages/web/src/store/radioStore.ts`
- **可能涉及**：错误提示相关的 UI 组件

#### 当前实现分析

**当前代码位置**：`packages/web/src/store/radioStore.ts`

当前错误处理逻辑：
```typescript
// 当前实现（简化）
wsClient.onWSEvent('error', (data) => {
  // 仅显示技术错误信息
  toast.error(data.message);
  console.error('[Error]', data);
});
```

**问题**：
- 只显示技术错误信息（如 "digitalRadioEngine.start() 执行失败"）
- 用户不知道该如何解决问题
- 没有利用新的错误字段

#### 修改内容

##### 1. 更新错误事件监听器

**位置**：`packages/web/src/store/radioStore.ts` 中的 `error` 事件处理器

**修改要点**：
- ✅ 优先显示 `userMessage`（用户友好提示）
- ✅ 显示第一条 `suggestions`（如果有）
- ✅ 根据 `severity` 决定提示持续时间
- ✅ 记录完整的技术错误日志

**实现代码**：

```typescript
// packages/web/src/store/radioStore.ts

import { addToast } from '@heroui/toast';

// 在 useEffect 中的 error 事件处理器
wsClient.onWSEvent('error', (data) => {
  // 解构新的错误字段
  const {
    message,           // 技术错误信息
    userMessage,       // 用户友好提示（新增）
    suggestions = [],  // 操作建议数组（新增）
    severity = 'error',// 错误严重程度（新增）
    code,              // 错误代码（新增）
    timestamp,         // 时间戳
    context            // 错误上下文（新增）
  } = data;

  // 构建描述文本
  let description = userMessage || message || '发生未知错误';

  // 如果有建议，添加第一条建议
  if (suggestions.length > 0) {
    description += `\n\n建议：${suggestions[0]}`;
  }

  // 映射 severity 到 color
  const colorMap = {
    info: 'primary' as const,
    warning: 'warning' as const,
    error: 'danger' as const,
    critical: 'danger' as const
  };

  const color = colorMap[severity] || 'danger';

  // 设置持续时间
  // critical: undefined（永不自动关闭）
  // error: 10000ms（10秒）
  // warning: 5000ms（5秒）
  // info: 3000ms（3秒）
  const timeoutMap = {
    critical: undefined,
    error: 10000,
    warning: 5000,
    info: 3000
  };

  const timeout = timeoutMap[severity] || 10000;

  // 显示 Toast
  addToast({
    title: severity === 'critical' ? '⚠️ 严重错误' : '错误',
    description,
    color,
    timeout
  });

  // 记录完整的技术错误日志
  console.error('[错误]', {
    code,
    severity,
    userMessage,
    technicalMessage: message,
    suggestions,
    timestamp,
    context
  });
});
```

##### 2. 更新 TypeScript 类型定义

**位置**：确保 `packages/contracts` 中的类型定义被正确导入

**类型定义**：

```typescript
// packages/web/src/store/radioStore.ts

// 导入错误相关类型（如果 contracts 包中有定义）
// import type { ErrorData } from '@tx5dr/contracts';

// 或者在本地定义类型（临时方案）
interface ErrorData {
  message: string;              // 技术错误信息
  userMessage?: string;         // 用户友好提示（新增）
  code?: string;                // 错误代码（新增）
  severity?: 'info' | 'warning' | 'error' | 'critical'; // 严重程度（新增）
  suggestions?: string[];       // 操作建议（新增）
  timestamp?: number;           // 时间戳
  context?: Record<string, any>; // 错误上下文（新增）
}
```

**注意**：建议在 `@tx5dr/contracts` 包中定义 `ErrorData` 类型，然后在前端导入，保持类型一致性。

#### 测试要点

**测试场景 1：电台连接失败**
- 触发方式：配置错误的电台 IP 地址，尝试启动引擎
- 预期结果：显示用户友好的提示（如 "无法连接到电台，请检查IP地址和网络连接"）
- 验证点：
  - ✅ Toast 显示 `userMessage` 而非技术错误
  - ✅ 显示操作建议（如 "检查电台IP地址配置"）
  - ✅ Console 包含完整的技术错误日志

**测试场景 2：配置错误**
- 触发方式：提供无效的配置参数
- 预期结果：显示配置错误的友好提示
- 验证点：
  - ✅ 显示具体的配置问题
  - ✅ 提供修正建议

**测试场景 3：严重错误（critical）**
- 触发方式：触发系统级严重错误
- 预期结果：Toast 不自动消失（后续 P1 任务）
- 验证点：
  - ✅ 用户必须手动关闭提示

#### 验收标准

- [ ] 所有错误都显示用户友好的提示（`userMessage`）
- [ ] 有操作建议时会显示第一条建议
- [ ] Console 包含完整的技术错误日志
- [ ] 不同严重程度的错误有不同的持续时间（critical 不消失）
- [ ] 不破坏现有功能（向后兼容）

---

### 任务 1.2：更新 HTTP API 错误处理

#### 目标
适配新的 HTTP API 错误响应格式，提供统一的错误处理体验。

#### 涉及文件
- **主要修改**：`packages/core/src/RadioService.ts`
- **可能涉及**：调用 RadioService 的组件

#### 当前实现分析

**当前代码位置**：`packages/core/src/RadioService.ts`

**当前特点**：
- 使用 fetch API 调用后端接口
- 错误处理较为简单，仅抛出错误
- 调用方需要自行处理错误

#### 修改内容

##### 1. 创建统一的错误处理函数

**位置**：`packages/core/src/RadioService.ts` 内部或新建工具函数

**实现代码**：

```typescript
// packages/core/src/RadioService.ts

/**
 * API 错误类
 */
class ApiError extends Error {
  code?: string;
  userMessage: string;
  suggestions: string[];
  severity: 'info' | 'warning' | 'error' | 'critical';
  httpStatus: number;
  context?: Record<string, any>;

  constructor(
    message: string,
    userMessage: string,
    httpStatus: number,
    options?: {
      code?: string;
      suggestions?: string[];
      severity?: 'info' | 'warning' | 'error' | 'critical';
      context?: Record<string, any>;
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.userMessage = userMessage;
    this.httpStatus = httpStatus;
    this.code = options?.code;
    this.suggestions = options?.suggestions || [];
    this.severity = options?.severity || 'error';
    this.context = options?.context;
  }
}

/**
 * 统一处理 API 错误响应
 */
function handleApiError(errorData: any, httpStatus: number): ApiError {
  const {
    message = '操作失败',
    userMessage,
    code,
    suggestions = [],
    severity = 'error',
    context
  } = errorData || {};

  // 记录技术日志
  console.error('[API 错误]', {
    httpStatus,
    code,
    message,
    userMessage,
    severity,
    suggestions,
    context
  });

  return new ApiError(
    message,
    userMessage || message || '操作失败，请稍后重试',
    httpStatus,
    { code, suggestions, severity, context }
  );
}
```

##### 2. 在所有 API 方法中应用错误处理

**需要更新的方法**：
- `startDecoding()`
- `stopDecoding()`
- `startEncoding()`
- `stopEncoding()`
- `setFrequency()`
- `setMode()`
- 其他所有 HTTP API 调用方法

**实现代码示例**：

```typescript
// packages/core/src/RadioService.ts

// 示例：startDecoding 方法
async startDecoding(): Promise<void> {
  try {
    const response = await fetch(`${this.baseUrl}/api/engine/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // 尝试解析错误响应
      try {
        const errorResponse = await response.json();
        throw handleApiError(errorResponse.error, response.status);
      } catch (parseError) {
        // 如果解析失败，创建通用错误
        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          '操作失败，请稍后重试',
          response.status
        );
      }
    }

    const result = await response.json();
    if (!result.success) {
      throw handleApiError(result.error, response.status);
    }
  } catch (error) {
    // 如果是网络错误（fetch 失败）
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ApiError(
        '网络请求失败',
        '无法连接到服务器，请检查网络连接',
        0,
        {
          code: 'NETWORK_ERROR',
          suggestions: ['检查网络连接', '确认服务器是否运行'],
          severity: 'error'
        }
      );
    }

    // 如果已经是 ApiError，直接抛出
    if (error instanceof ApiError) {
      throw error;
    }

    // 其他未知错误
    throw new ApiError(
      error instanceof Error ? error.message : String(error),
      '发生未知错误，请稍后重试',
      500
    );
  }
}

// 示例：setFrequency 方法
async setFrequency(frequency: number): Promise<void> {
  try {
    const response = await fetch(`${this.baseUrl}/api/radio/frequency`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ frequency }),
    });

    if (!response.ok) {
      try {
        const errorResponse = await response.json();
        throw handleApiError(errorResponse.error, response.status);
      } catch (parseError) {
        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          '设置频率失败，请稍后重试',
          response.status
        );
      }
    }

    const result = await response.json();
    if (!result.success) {
      throw handleApiError(result.error, response.status);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ApiError(
        '网络请求失败',
        '无法连接到服务器，请检查网络连接',
        0,
        {
          code: 'NETWORK_ERROR',
          suggestions: ['检查网络连接', '确认服务器是否运行'],
          severity: 'error'
        }
      );
    }

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      error instanceof Error ? error.message : String(error),
      '设置频率失败，请稍后重试',
      500
    );
  }
}
```

**重构建议**：为了避免重复代码，可以创建一个通用的 `apiRequest` 方法：

```typescript
/**
 * 通用 API 请求方法
 */
private async apiRequest<T = any>(
  path: string,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      try {
        const errorResponse = await response.json();
        throw handleApiError(errorResponse.error, response.status);
      } catch (parseError) {
        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          '操作失败，请稍后重试',
          response.status
        );
      }
    }

    const result = await response.json();
    if (!result.success) {
      throw handleApiError(result.error, response.status);
    }

    return result.data || result;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ApiError(
        '网络请求失败',
        '无法连接到服务器，请检查网络连接',
        0,
        {
          code: 'NETWORK_ERROR',
          suggestions: ['检查网络连接', '确认服务器是否运行'],
          severity: 'error'
        }
      );
    }

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      error instanceof Error ? error.message : String(error),
      '发生未知错误，请稍后重试',
      500
    );
  }
}

// 简化后的方法
async startDecoding(): Promise<void> {
  await this.apiRequest('/api/engine/start', { method: 'POST' });
}

async setFrequency(frequency: number): Promise<void> {
  await this.apiRequest('/api/radio/frequency', {
    method: 'POST',
    body: JSON.stringify({ frequency }),
  });
}
```

##### 3. 在调用方捕获并显示错误

**位置**：调用 RadioService 的组件（如 RadioControl.tsx）

**实现代码**：

```typescript
// packages/web/src/components/RadioControl.tsx

import { showErrorToast } from '@/utils/errorToast'; // 使用封装的工具函数

// 在组件中调用 API
const handleStartDecoding = async () => {
  try {
    await radioService.startDecoding();
    showSuccessToast('引擎启动成功');
  } catch (error) {
    // 如果是 ApiError，提取错误信息并显示
    if (error instanceof Error && 'userMessage' in error) {
      const apiError = error as any;
      showErrorToast({
        userMessage: apiError.userMessage,
        suggestions: apiError.suggestions,
        severity: apiError.severity,
        code: apiError.code,
        technicalDetails: apiError.message
      });
    } else {
      // 兜底错误处理
      showErrorToast({
        userMessage: '操作失败，请稍后重试',
        severity: 'error'
      });
    }
  }
};
```

#### HTTP 状态码处理策略

| HTTP 状态码 | 含义 | 处理策略 |
|------------|------|---------|
| 400 | 配置/操作错误 | 显示配置错误提示，高亮错误参数 |
| 404 | 设备未找到 | 提供跳转到设置页面的链接 |
| 409 | 状态冲突 | 显示当前状态和期望状态，提供刷新按钮 |
| 500 | 服务器错误 | 显示友好的服务器错误提示，建议重试 |
| 503 | 服务不可用 | 显示服务不可用提示，建议稍后重试 |

#### 测试要点

**测试场景 1：引擎未启动时调用 API**
- 触发方式：引擎未启动状态下调用 `setFrequency()`
- 预期结果：显示 "引擎未启动，请先启动引擎"
- HTTP 状态码：409
- 验证点：
  - ✅ Toast 显示用户友好的提示
  - ✅ 显示操作建议

**测试场景 2：无效的配置参数**
- 触发方式：调用 `setMode('INVALID_MODE')`
- 预期结果：显示 "模式参数无效"
- HTTP 状态码：400
- 验证点：
  - ✅ 指出具体的无效参数
  - ✅ 提供有效参数列表

**测试场景 3：网络错误**
- 触发方式：断开网络，调用任意 API
- 预期结果：显示 "网络连接失败"
- 验证点：
  - ✅ 捕获 fetch 网络异常
  - ✅ 显示友好的网络错误提示

#### 验收标准

- [ ] 所有 API 方法都使用统一的错误处理
- [ ] HTTP 错误响应正确解析新的错误格式
- [ ] 显示用户友好的错误提示（`userMessage`）
- [ ] 不同 HTTP 状态码有相应的处理策略
- [ ] 网络错误有友好的提示
- [ ] Console 包含完整的技术错误日志

---

## 阶段2：P1 推荐调整

> **优先级**：⭐ 中高
> **预计工作量**：8-10 小时
> **目标**：提升错误处理的用户体验

### 任务 2.1：添加错误严重程度 UI 区分

#### 目标
根据错误的严重程度（severity）使用不同的 UI 表现，让用户清楚地了解错误的重要性。

#### 涉及文件
- **主要修改**：`packages/web/src/store/radioStore.ts` 或 Toast 组件配置
- **可能涉及**：Toast 库的配置文件

#### 设计方案

##### 错误严重程度分类

| Severity | 中文 | 含义 | UI表现 | 持续时间 | 用户操作 |
|----------|------|------|--------|---------|---------|
| `critical` | 严重错误 | 系统级错误，需要立即处理 | 红色，❌ 图标 | 不自动消失 | 必须手动关闭 |
| `error` | 错误 | 操作失败，影响功能 | 橙红色，⚠️ 图标 | 5秒 | 可自动消失 |
| `warning` | 警告 | 潜在问题，不影响核心功能 | 黄色，⚡ 图标 | 3秒 | 可自动消失 |
| `info` | 信息 | 提示性信息 | 蓝色，ℹ️ 图标 | 2秒 | 可自动消失 |

##### UI 设计要求

**1. 颜色方案**（根据项目使用的 HeroUI 主题调整）
- critical: `bg-danger-500` 或 `#f31260`
- error: `bg-warning-500` 或 `#f5a524`
- warning: `bg-warning-400` 或 `#ffc107`
- info: `bg-primary-500` 或 `#0070f3`

**2. 图标方案**
- critical: `XCircleIcon` 或 `ExclamationTriangleIcon`
- error: `ExclamationCircleIcon`
- warning: `ExclamationIcon`
- info: `InformationCircleIcon`

**3. 声音提示**（可选）
- critical: 错误音效
- error: 轻微提示音
- warning: 无声音
- info: 无声音

#### 修改内容

##### 1. 更新错误事件处理器

**位置**：`packages/web/src/store/radioStore.ts` 中的 `error` 事件处理器

**TODO：添加 severity UI 区分逻辑**

```typescript
// TODO: 扩展任务 1.1 的错误处理逻辑
// 新增：
// 1. 根据 severity 选择不同的 toast 类型或样式
// 2. 设置不同的持续时间（critical: null, error: 5000, warning: 3000, info: 2000）
// 3. 添加不同的图标
// 4. critical 错误需要用户手动关闭（duration: null 或 Infinity）
// 5. 可选：添加声音提示
```

##### 2. 创建 Toast 配置映射

**TODO：Severity 配置映射**

```typescript
// TODO: 创建 severityToToastConfig 映射对象
// 包含：type, duration, icon, className, closeable
// critical: { type: 'error', duration: null, closeable: true, ... }
// error: { type: 'error', duration: 5000, closeable: true, ... }
// warning: { type: 'warning', duration: 3000, closeable: true, ... }
// info: { type: 'info', duration: 2000, closeable: false, ... }
```

##### 3. 扩展 Toast 组件（如果需要）

如果当前使用的 Toast 库不支持某些特性，可能需要：
- 自定义 Toast 组件
- 或使用第三方库（如 react-hot-toast、sonner 等）

**TODO：评估当前 Toast 库的能力**

```typescript
// TODO: 检查当前项目使用的 Toast 库
// 确认是否支持：
// 1. 自定义持续时间（包括永不消失）
// 2. 自定义图标
// 3. 自定义样式/className
// 4. 可关闭/不可关闭控制
// 如果不支持，考虑切换到 react-hot-toast 或 sonner
```

#### 测试要点

**测试场景 1：Critical 错误**
- 触发方式：触发系统级严重错误（如引擎启动严重失败）
- 预期结果：
  - ✅ Toast 显示红色背景，❌ 图标
  - ✅ Toast 不会自动消失
  - ✅ 必须点击关闭按钮才能关闭
  - ✅ 可能播放错误音效

**测试场景 2：Error 错误**
- 触发方式：电台连接失败
- 预期结果：
  - ✅ Toast 显示橙红色背景，⚠️ 图标
  - ✅ 5秒后自动消失
  - ✅ 可以手动关闭

**测试场景 3：Warning 警告**
- 触发方式：配置项缺失但有默认值
- 预期结果：
  - ✅ Toast 显示黄色背景，⚡ 图标
  - ✅ 3秒后自动消失

**测试场景 4：Info 信息**
- 触发方式：一般性提示信息
- 预期结果：
  - ✅ Toast 显示蓝色背景，ℹ️ 图标
  - ✅ 2秒后自动消失

#### 验收标准

- [ ] Critical 错误不会自动消失，需要手动关闭
- [ ] Error、Warning、Info 错误有不同的自动消失时间
- [ ] 不同严重程度使用不同的颜色和图标
- [ ] UI 表现符合设计方案
- [ ] 用户能够清楚地区分错误的重要性

---

### 任务 2.2：创建错误建议展示组件

#### 目标
创建一个专门的 Dialog 组件，用于展示完整的错误信息、操作建议和上下文。

#### 涉及文件
- **新建文件**：`packages/web/src/components/ErrorSuggestionsDialog.tsx`
- **修改文件**：`packages/web/src/store/radioStore.ts`（或错误处理相关的组件）

#### 设计方案

##### 组件功能
1. 展示完整的错误信息
2. 显示所有操作建议（而不仅仅是第一条）
3. 显示错误代码和时间戳
4. 提供复制错误信息的功能
5. 显示错误上下文（如果有）

##### UI 设计

**Dialog 布局**：
```
┌─────────────────────────────────────┐
│ [图标] 发生错误                       │
├─────────────────────────────────────┤
│ 用户友好的错误描述 (userMessage)      │
│                                     │
│ 🔧 操作建议：                         │
│ 1. 第一条建议                         │
│ 2. 第二条建议                         │
│ 3. 第三条建议                         │
│                                     │
│ 📋 技术信息：                         │
│ 错误代码：CONNECTION_FAILED           │
│ 时间：2025-11-03 14:30:25           │
│ [复制错误信息]                        │
│                                     │
│ ▼ 详细上下文（可折叠）                 │
│   { "ip": "192.168.1.100", ... }   │
│                                     │
│              [关闭]                  │
└─────────────────────────────────────┘
```

#### 修改内容

##### 1. 创建 ErrorSuggestionsDialog 组件

**新建文件**：`packages/web/src/components/ErrorSuggestionsDialog.tsx`

**TODO：ErrorSuggestionsDialog 组件实现**

```typescript
// TODO: 创建 ErrorSuggestionsDialog 组件
// Props:
// - isOpen: boolean
// - onClose: () => void
// - errorData: ErrorData (包含所有错误字段)
//
// 功能：
// 1. 使用 HeroUI 的 Modal 组件作为基础
// 2. 显示 userMessage 作为主要描述
// 3. 列出所有 suggestions（有序列表）
// 4. 显示技术信息：code, timestamp, message
// 5. 添加"复制错误信息"按钮（复制格式化的文本）
// 6. 可选：显示 context（JSON 格式，可折叠）
// 7. 使用与 severity 对应的图标和颜色
```

##### 2. 创建错误信息存储和管理

**位置**：`packages/web/src/store/radioStore.ts` 或新建 `errorStore.ts`

**TODO：错误状态管理**

```typescript
// TODO: 添加错误详情状态
// 状态：
// - currentError: ErrorData | null
// - isErrorDialogOpen: boolean
//
// Action:
// - showErrorDetails(errorData: ErrorData)
// - closeErrorDialog()
```

##### 3. 在 Toast 中添加"查看详情"按钮

**位置**：`packages/web/src/store/radioStore.ts` 中的错误处理

**TODO：Toast 添加查看详情按钮**

```typescript
// TODO: 在 toast 中添加 action 按钮
// 按钮文本："查看详情"或"查看建议"
// 点击后：
// 1. 关闭当前 Toast
// 2. 打开 ErrorSuggestionsDialog
// 3. 传入完整的 errorData
//
// 注意：只在 suggestions 存在且长度 > 1 时显示此按钮
```

##### 4. 实现复制功能

**TODO：复制错误信息功能**

```typescript
// TODO: 实现 copyErrorInfo 函数
// 复制格式：
// ---
// 错误描述：{userMessage}
// 错误代码：{code}
// 时间：{formatted timestamp}
//
// 操作建议：
// 1. {suggestion1}
// 2. {suggestion2}
// ...
//
// 技术信息：{message}
// ---
//
// 使用 navigator.clipboard.writeText
// 复制后显示 toast 提示："已复制到剪贴板"
```

#### 测试要点

**测试场景 1：查看多条建议**
- 触发方式：触发有多条 suggestions 的错误
- 预期结果：
  - ✅ Toast 显示"查看详情"按钮
  - ✅ 点击后打开 Dialog
  - ✅ Dialog 显示所有建议（有序列表）

**测试场景 2：复制错误信息**
- 触发方式：打开 ErrorSuggestionsDialog，点击"复制错误信息"
- 预期结果：
  - ✅ 错误信息被复制到剪贴板
  - ✅ 显示"已复制到剪贴板"提示
  - ✅ 复制的文本格式化良好

**测试场景 3：显示错误上下文**
- 触发方式：触发包含 context 的错误
- 预期结果：
  - ✅ Dialog 显示"详细上下文"折叠区域
  - ✅ 展开后显示 JSON 格式的上下文
  - ✅ JSON 格式化美观（缩进、语法高亮）

**测试场景 4：没有建议的错误**
- 触发方式：触发没有 suggestions 的错误
- 预期结果：
  - ✅ Toast 不显示"查看详情"按钮
  - ✅ 仅显示 userMessage

#### 验收标准

- [ ] ErrorSuggestionsDialog 组件创建完成
- [ ] 可以显示完整的错误信息和所有建议
- [ ] Toast 中有"查看详情"按钮（当有多条建议时）
- [ ] 复制功能正常工作
- [ ] 错误上下文可以展开查看
- [ ] UI 美观，符合项目设计风格

---

### 任务 2.3：根据错误代码执行特殊处理

#### 目标
根据不同的错误代码（`code`）执行特殊的处理逻辑，提供更加智能的用户体验。

#### 涉及文件
- **主要修改**：`packages/web/src/store/radioStore.ts`
- **可能涉及**：路由配置、导航函数

#### 设计方案

##### 常见错误代码的特殊处理

| 错误代码 | 特殊处理逻辑 | 额外 UI 元素 |
|---------|------------|-------------|
| `CONNECTION_FAILED` | 提供"重试连接"按钮 | 按钮：重试连接 |
| `DEVICE_NOT_FOUND` | 提供跳转到设置页面的链接 | 按钮：前往设置 |
| `CONFIG_ERROR` | 高亮显示错误的配置项 | 自动打开配置页面 |
| `INVALID_FREQUENCY` | 显示有效频率范围 | 输入框高亮 |
| `INVALID_MODE` | 显示支持的模式列表 | 下拉菜单高亮 |
| `STATE_CONFLICT` | 显示当前状态和期望状态 | 刷新按钮 |
| `RESOURCE_BUSY` | 显示被占用的资源 | 等待/重试选项 |
| `TIMEOUT` | 提供延长超时或重试选项 | 按钮：重试 |

#### 修改内容

##### 1. 创建错误代码处理映射

**位置**：`packages/web/src/store/radioStore.ts` 或独立文件

**TODO：错误代码处理映射**

```typescript
// TODO: 创建 errorCodeHandlers 映射
// 类型：Record<RadioErrorCode, (errorData: ErrorData) => void>
//
// 每个处理函数应该：
// 1. 显示特定的 UI 元素（按钮、链接等）
// 2. 提供快捷操作（重试、跳转等）
// 3. 可选：自动执行某些操作（如打开配置页面）
//
// 示例：
// CONNECTION_FAILED: (data) => {
//   // 显示带有"重试连接"按钮的 Toast
// }
```

##### 2. 扩展 Toast 支持 Action 按钮

**TODO：Toast Action 按钮实现**

```typescript
// TODO: 扩展 Toast 配置以支持 action 按钮
// 根据错误代码添加相应的操作按钮
//
// CONNECTION_FAILED:
// - 按钮文本："重试连接"
// - 点击操作：调用 radioService.reconnect() 或重新启动引擎
//
// DEVICE_NOT_FOUND:
// - 按钮文本："前往设置"
// - 点击操作：导航到 /settings/radio
//
// STATE_CONFLICT:
// - 按钮文本："刷新状态"
// - 点击操作：调用 radioService.getStatus()
//
// TIMEOUT:
// - 按钮文本："重试"
// - 点击操作：重试上一次的操作
```

##### 3. 实现重试逻辑

**TODO：重试机制实现**

```typescript
// TODO: 实现重试逻辑
// 1. 记录最后一次失败的操作（命令、参数）
// 2. 提供 retry() 函数
// 3. 在 Toast 的 action 按钮中调用
//
// 示例：
// lastFailedOperation = {
//   command: 'startEngine',
//   params: { ... }
// }
//
// retry() {
//   if (lastFailedOperation) {
//     radioService[lastFailedOperation.command](...params);
//   }
// }
```

##### 4. 实现导航跳转

**TODO：导航跳转实现**

```typescript
// TODO: 根据错误代码执行页面跳转
// DEVICE_NOT_FOUND -> /settings/radio
// CONFIG_ERROR -> /settings/config (可选：带查询参数高亮错误项)
// INVALID_FREQUENCY -> 保持当前页，但高亮频率输入框
//
// 使用 React Router 的 useNavigate 或类似 API
```

#### 常见错误代码的详细处理逻辑

##### CONNECTION_FAILED（连接失败）

**UI 表现**：
- Toast 显示："{userMessage}"
- Action 按钮："重试连接"

**处理逻辑**：
```typescript
// TODO: CONNECTION_FAILED 处理
// 1. 显示带有"重试连接"按钮的 Toast
// 2. 点击后：
//    a. 关闭 Toast
//    b. 显示 loading 状态
//    c. 调用 radioService.startEngine() 或 reconnect()
//    d. 成功：显示成功提示
//    e. 失败：再次显示错误（可添加重试次数限制）
```

##### DEVICE_NOT_FOUND（设备未找到）

**UI 表现**：
- Toast 显示："{userMessage}"
- Action 按钮："前往设置"

**处理逻辑**：
```typescript
// TODO: DEVICE_NOT_FOUND 处理
// 1. 显示带有"前往设置"按钮的 Toast
// 2. 点击后：
//    a. 关闭 Toast
//    b. 导航到 /settings/radio
//    c. 可选：高亮电台配置区域
```

##### CONFIG_ERROR（配置错误）

**UI 表现**：
- Toast 显示："{userMessage}"
- Action 按钮："检查配置"

**处理逻辑**：
```typescript
// TODO: CONFIG_ERROR 处理
// 1. 从 context 中提取错误的配置项名称
// 2. 显示带有"检查配置"按钮的 Toast
// 3. 点击后：
//    a. 关闭 Toast
//    b. 导航到配置页面
//    c. 高亮或滚动到错误的配置项
```

##### INVALID_FREQUENCY（无效频率）

**UI 表现**：
- Toast 显示："{userMessage}（有效范围：{min}-{max} MHz）"
- 高亮频率输入框（红色边框）

**处理逻辑**：
```typescript
// TODO: INVALID_FREQUENCY 处理
// 1. 从 context 中提取有效频率范围
// 2. 在 Toast 中显示有效范围
// 3. 高亮当前页面的频率输入框
// 4. 可选：设置输入框的 min/max 属性
```

##### STATE_CONFLICT（状态冲突）

**UI 表现**：
- Toast 显示："{userMessage}"
- Action 按钮："刷新状态"

**处理逻辑**：
```typescript
// TODO: STATE_CONFLICT 处理
// 1. 显示当前状态和期望状态（从 context 中提取）
// 2. 显示带有"刷新状态"按钮的 Toast
// 3. 点击后：
//    a. 关闭 Toast
//    b. 调用 radioService.getStatus() 刷新状态
//    c. 更新前端状态
```

#### 测试要点

**测试场景 1：CONNECTION_FAILED 重试**
- 触发方式：电台连接失败
- 预期结果：
  - ✅ Toast 显示"重试连接"按钮
  - ✅ 点击后重新尝试连接
  - ✅ 显示 loading 状态
  - ✅ 成功或失败都有相应提示

**测试场景 2：DEVICE_NOT_FOUND 跳转**
- 触发方式：设备未找到
- 预期结果：
  - ✅ Toast 显示"前往设置"按钮
  - ✅ 点击后导航到设置页面
  - ✅ 高亮电台配置区域

**测试场景 3：CONFIG_ERROR 高亮**
- 触发方式：配置错误
- 预期结果：
  - ✅ Toast 显示"检查配置"按钮
  - ✅ 点击后导航到配置页面
  - ✅ 错误的配置项被高亮

**测试场景 4：INVALID_FREQUENCY 范围提示**
- 触发方式：输入无效频率
- 预期结果：
  - ✅ Toast 显示有效频率范围
  - ✅ 频率输入框被高亮（红色边框）

#### 验收标准

- [ ] 所有常见错误代码都有特殊处理逻辑
- [ ] Toast 中显示相应的 Action 按钮
- [ ] 按钮点击后执行正确的操作（重试、跳转等）
- [ ] 高亮和导航功能正常工作
- [ ] 用户体验流畅，操作直观

---

## 阶段3：P2 代码质量优化

> **优先级**：💡 低
> **预计工作量**：8-10 小时
> **目标**：提升代码质量，防止技术债务

### 任务 3.1：迁移到 useWSEvent Hook

#### 目标
将所有手动管理的 WebSocket 事件订阅迁移到 `useWSEvent` Hook，防止内存泄漏，简化代码。

#### 背景

**当前状况**：
- 项目已提供 `useWSEvent` 和 `useWSEvents` Hook（位于 `packages/web/src/hooks/useWSEvent.ts`）
- 大部分组件仍使用手动管理模式（`useEffect` + `onWSEvent`/`offWSEvent`）
- 手动管理模式虽然可行，但需要开发者记住配对清理，容易出错

**useWSEvent Hook 的优势**：
1. 自动清理，防止内存泄漏
2. 代码更简洁（减少 10-15 行代码）
3. 完整的 TypeScript 类型支持
4. 依赖自动追踪（使用 React 的依赖数组）

#### 涉及文件

**需要迁移的组件**（预估）：
- `packages/web/src/components/RadioControl.tsx`
- `packages/web/src/components/SpectrumDisplay.tsx`
- `packages/web/src/components/RadioOperator.tsx`
- `packages/web/src/components/FramesTable.tsx`
- `packages/web/src/components/WebGLWaterfall.tsx`
- 其他使用手动管理的组件（约 5-8 个）

#### 修改内容

##### 迁移步骤（每个组件）

**步骤 1：识别手动管理的事件订阅**

查找以下模式：
```typescript
useEffect(() => {
  const wsClient = radioService.wsClientInstance;
  const handleEvent = (data) => { /* ... */ };
  wsClient.onWSEvent('eventName', handleEvent);

  return () => {
    wsClient.offWSEvent('eventName', handleEvent);
  };
}, [dependencies]);
```

**步骤 2：替换为 useWSEvent**

**TODO：单事件订阅迁移示例**

```typescript
// 旧方式（手动管理）
// TODO: 展示手动管理的完整代码

// 新方式（useWSEvent Hook）
// TODO: 展示使用 useWSEvent 的代码
// 重点：
// 1. 导入 useWSEvent
// 2. 简化为一行调用
// 3. 依赖数组自动处理
// 4. 回调函数中可以使用组件状态
```

**步骤 3：多事件订阅使用 useWSEvents**

如果组件订阅多个事件，可以使用 `useWSEvents`：

**TODO：多事件订阅迁移示例**

```typescript
// 旧方式（多个 useEffect）
// TODO: 展示多个 useEffect 的代码

// 新方式（useWSEvents Hook）
// TODO: 展示使用 useWSEvents 的代码
// 传入事件对象：{ eventName1: handler1, eventName2: handler2 }
```

**步骤 4：验证依赖数组**

确保依赖数组包含回调函数中使用的所有外部变量：
```typescript
useWSEvent(
  radioService,
  'spectrumData',
  (data) => {
    processData(data, someState); // someState 应该在依赖数组中
  },
  [someState] // 依赖数组
);
```

##### 组件迁移优先级

| 优先级 | 组件 | 订阅事件数 | 预计时间 | 原因 |
|-------|------|-----------|---------|------|
| 1 | RadioControl.tsx | 2-3 | 1h | 核心控制组件 |
| 2 | SpectrumDisplay.tsx | 1-2 | 1h | 高频数据订阅 |
| 3 | RadioOperator.tsx | 2-3 | 1h | 操作员状态管理 |
| 4 | FramesTable.tsx | 1-2 | 1h | 数据展示组件 |
| 5 | WebGLWaterfall.tsx | 1-2 | 1h | 高频渲染组件 |
| 6 | 其他组件 | 各不同 | 3-4h | 逐步迁移 |

#### 迁移检查清单（每个组件）

**迁移前**：
- [ ] 识别所有手动管理的事件订阅
- [ ] 记录事件名称和处理函数
- [ ] 记录依赖数组中的变量

**迁移中**：
- [ ] 导入 `useWSEvent` 或 `useWSEvents`
- [ ] 替换手动管理代码
- [ ] 正确设置依赖数组
- [ ] 删除不再需要的 `useEffect`

**迁移后**：
- [ ] 功能测试：确保事件订阅正常工作
- [ ] 清理测试：组件卸载后事件监听器被移除
- [ ] 代码审查：依赖数组正确，无 ESLint 警告

#### 测试要点

**测试场景 1：功能正常**
- 验证方式：迁移后组件功能与迁移前完全一致
- 预期结果：
  - ✅ 事件数据正确接收
  - ✅ UI 正确更新
  - ✅ 无 console 错误

**测试场景 2：内存泄漏检查**
- 验证方式：
  1. 打开 Chrome DevTools Memory Profiler
  2. 记录堆快照
  3. 挂载/卸载组件 10 次
  4. 再次记录堆快照
  5. 比较前后堆大小
- 预期结果：
  - ✅ 堆大小稳定，无明显增长
  - ✅ 事件监听器数量不累积

**测试场景 3：依赖数组正确**
- 验证方式：依赖变化时回调函数使用最新值
- 预期结果：
  - ✅ 依赖变化后，回调函数行为正确
  - ✅ 无 React Hooks 依赖警告

#### 验收标准

- [ ] 所有目标组件都已迁移到 `useWSEvent` Hook
- [ ] 功能测试全部通过
- [ ] 无内存泄漏
- [ ] 代码更简洁（每个组件减少 10-15 行代码）
- [ ] TypeScript 类型检查通过
- [ ] 无 ESLint 警告

---

### 任务 3.2：统一 API 调用封装

#### 目标
创建统一的 API 客户端，封装所有 HTTP API 调用，提供统一的错误处理、重试逻辑和 loading 状态管理。

#### 背景

**当前状况**：
- RadioService 中的每个方法都单独处理 API 调用
- 错误处理逻辑重复
- 没有统一的 loading 状态管理
- 没有重试机制

**统一封装的优势**：
1. 减少重复代码
2. 统一错误处理
3. 自动重试失败的请求（可配置）
4. 统一 loading 状态管理
5. 请求/响应拦截器
6. 请求日志和监控

#### 涉及文件

- **新建文件**：`packages/core/src/ApiClient.ts`
- **修改文件**：`packages/core/src/RadioService.ts`（使用新的 ApiClient）
- **可能涉及**：所有调用 RadioService 的组件

#### 设计方案

##### ApiClient 功能清单

1. **基础功能**：
   - 封装 fetch API
   - 自动添加 base URL
   - 自动序列化/反序列化 JSON

2. **错误处理**：
   - 统一解析错误响应（任务 1.2 的错误格式）
   - 自动显示错误 Toast
   - 抛出格式化的错误对象

3. **重试机制**（可选）：
   - 网络错误自动重试（最多 3 次）
   - 指数退避算法
   - 可配置的重试策略

4. **Loading 状态**：
   - 全局 loading 状态
   - 每个请求的 loading 状态
   - 与 React Context 或 Store 集成

5. **拦截器**：
   - 请求拦截器（添加 headers、token 等）
   - 响应拦截器（统一处理响应、错误）

6. **日志和监控**：
   - 请求日志（开发环境）
   - 错误监控（可集成 Sentry 等）
   - 性能监控（请求耗时）

#### 修改内容

##### 1. 创建 ApiClient 类

**新建文件**：`packages/core/src/ApiClient.ts`

**TODO：ApiClient 类实现**

```typescript
// TODO: 实现 ApiClient 类
//
// 类结构：
// class ApiClient {
//   constructor(config: ApiClientConfig)
//   get<T>(url, options?)
//   post<T>(url, data?, options?)
//   put<T>(url, data?, options?)
//   delete<T>(url, options?)
//
//   // 私有方法
//   private request<T>(method, url, options)
//   private handleError(error, response)
//   private retry(fn, retries, delay)
// }
//
// 配置选项：
// - baseURL: string
// - timeout: number
// - retryCount: number
// - retryDelay: number
// - showErrorToast: boolean
// - onRequest: (config) => config
// - onResponse: (response) => response
// - onError: (error) => void
```

##### 2. 实现统一错误处理

**TODO：统一错误处理函数**

```typescript
// TODO: 实现 handleApiError 方法
//
// 功能：
// 1. 解析 HTTP 响应中的 error 对象（ErrorData 格式）
// 2. 创建 ApiError 实例
// 3. 显示 Toast（如果配置允许）
// 4. 记录日志
// 5. 返回格式化的错误对象
//
// 处理不同场景：
// - HTTP 错误响应（包含 error 对象）
// - 网络错误（fetch 失败）
// - 超时错误
// - 解析错误（JSON.parse 失败）
```

##### 3. 实现重试机制（可选）

**TODO：重试机制实现**

```typescript
// TODO: 实现 retry 方法
//
// 策略：
// 1. 仅对特定错误重试（网络错误、5xx 错误）
// 2. 使用指数退避算法：delay * 2^retryCount
// 3. 最大重试次数：3 次
// 4. 可配置的重试条件
//
// 不重试的情况：
// - 4xx 客户端错误（除了 408 Timeout）
// - 用户取消的请求
// - 重试次数已达上限
```

##### 4. 实现 Loading 状态管理

**TODO：Loading 状态管理**

```typescript
// TODO: 集成 Loading 状态
//
// 方案 1：使用 React Context
// - 创建 LoadingContext
// - ApiClient 发起请求时设置 loading 为 true
// - 请求完成（成功或失败）设置 loading 为 false
//
// 方案 2：使用全局 Store（如果项目使用 Zustand/Redux）
// - 在 Store 中添加 loading 状态
// - ApiClient 通过 Store API 更新状态
//
// 方案 3：返回 loading 状态（useQuery 风格）
// - 每个 API 方法返回 { data, loading, error }
// - 调用方自行管理 loading 状态
```

##### 5. 添加请求/响应拦截器

**TODO：拦截器实现**

```typescript
// TODO: 实现拦截器机制
//
// 请求拦截器：
// - 添加通用 headers（Content-Type, Accept）
// - 添加认证 token（如果有）
// - 记录请求日志（开发环境）
//
// 响应拦截器：
// - 统一处理响应格式
// - 提取数据（response.data）
// - 处理特殊状态码（401 跳转登录等）
// - 记录响应日志（开发环境）
```

##### 6. 更新 RadioService 使用 ApiClient

**修改文件**：`packages/core/src/RadioService.ts`

**TODO：RadioService 重构**

```typescript
// TODO: 重构 RadioService 使用 ApiClient
//
// 步骤：
// 1. 在 constructor 中创建 ApiClient 实例
//    this.apiClient = new ApiClient({ baseURL: this.baseUrl })
//
// 2. 替换所有 fetch 调用为 apiClient 方法
//    旧：fetch(`${this.baseUrl}/api/engine/start`)
//    新：this.apiClient.post('/api/engine/start')
//
// 3. 移除重复的错误处理代码（ApiClient 已处理）
//
// 4. 简化方法实现（每个方法减少 5-10 行代码）
//
// 需要更新的方法：
// - startDecoding()
// - stopDecoding()
// - startEncoding()
// - stopEncoding()
// - setFrequency()
// - setMode()
// - 其他所有 HTTP API 方法
```

#### API 方法示例对比

**重构前**：
```typescript
// TODO: 展示重构前的 startDecoding 方法
// 包含：
// - fetch 调用
// - 响应解析
// - 错误处理
// - try-catch
// 约 15-20 行代码
```

**重构后**：
```typescript
// TODO: 展示重构后的 startDecoding 方法
// 使用 ApiClient
// 约 3-5 行代码
```

#### 测试要点

**测试场景 1：正常 API 调用**
- 验证方式：调用任意 RadioService 方法
- 预期结果：
  - ✅ 请求正常发送
  - ✅ 响应正确解析
  - ✅ 数据返回给调用方

**测试场景 2：错误处理**
- 验证方式：触发 API 错误（连接失败、500 错误等）
- 预期结果：
  - ✅ 错误被正确捕获和解析
  - ✅ 显示用户友好的 Toast
  - ✅ 抛出格式化的错误对象

**测试场景 3：重试机制**
- 验证方式：模拟网络抖动（第一次失败，第二次成功）
- 预期结果：
  - ✅ 第一次失败后自动重试
  - ✅ 第二次成功返回数据
  - ✅ 用户无感知

**测试场景 4：Loading 状态**
- 验证方式：发起耗时的 API 调用
- 预期结果：
  - ✅ 调用开始时 loading 为 true
  - ✅ 调用结束后 loading 为 false
  - ✅ UI 显示 loading 指示器

**测试场景 5：请求取消**
- 验证方式：组件卸载前取消请求
- 预期结果：
  - ✅ 请求被取消
  - ✅ 不显示错误提示
  - ✅ 不更新已卸载组件的状态

#### 验收标准

- [ ] ApiClient 类创建完成
- [ ] 统一错误处理功能正常
- [ ] 重试机制工作正常（如果实现）
- [ ] Loading 状态管理正常
- [ ] 拦截器功能正常
- [ ] RadioService 所有方法已重构
- [ ] 所有 API 调用功能正常
- [ ] 代码简化（每个方法减少 5-10 行）
- [ ] 单元测试覆盖核心功能

---

### 任务 3.3：更新项目文档

#### 目标
更新项目文档，记录所有架构变更、新的最佳实践和迁移指南。

#### 涉及文件

- **修改文件**：`packages/web/CLAUDE.md`
- **可能修改**：`CLAUDE.md`（根目录）
- **新建文件**：`docs/error-handling-guide.md`（可选）

#### 修改内容

##### 1. 更新 packages/web/CLAUDE.md

**TODO：更新 Web 包文档**

```markdown
# TODO: 在 packages/web/CLAUDE.md 中添加以下内容：

## 错误处理
- 新的错误消息格式（ErrorData）
- 如何处理 WebSocket ERROR 事件
- 如何处理 HTTP API 错误
- 错误严重程度 UI 区分
- 错误建议展示

## WebSocket 事件订阅最佳实践
- 使用 useWSEvent Hook（推荐）
- 手动管理模式（已弃用，但仍兼容）
- 内存泄漏防范

## API 调用最佳实践
- 使用 ApiClient 统一封装
- 错误处理
- Loading 状态管理
- 重试策略

## 组件开发规范
- 必须使用 useWSEvent Hook 订阅事件
- 必须使用 ApiClient 调用 API
- 错误提示必须显示 userMessage
```

##### 2. 创建错误处理指南（可选）

**新建文件**：`docs/error-handling-guide.md`

**TODO：错误处理指南内容**

```markdown
# TODO: 创建完整的错误处理指南
# 包含：
# - 错误消息格式详解
# - 所有错误代码列表和说明
# - 前端错误处理最佳实践
# - 常见错误场景和解决方案
# - FAQ
```

##### 3. 更新根目录 CLAUDE.md

**TODO：更新根文档**

```markdown
# TODO: 在根目录 CLAUDE.md 中添加：
# - 架构重构说明（简述）
# - 前端适配说明（链接到本文档）
# - 错误处理变更（简述）
```

#### 验收标准

- [ ] packages/web/CLAUDE.md 已更新
- [ ] 文档内容准确、完整
- [ ] 包含代码示例和最佳实践
- [ ] 根目录 CLAUDE.md 已更新（如果需要）

---

## 实施检查清单

### 阶段 1：P0 必须调整（✅完成标准）

- [ ] **任务 1.1：更新 WebSocket ERROR 事件处理器**
  - [ ] 修改 radioStore.ts 中的 error 事件处理器
  - [ ] 显示 userMessage 和 suggestions
  - [ ] 根据 severity 设置持续时间
  - [ ] 记录技术错误日志
  - [ ] 测试：电台连接失败、配置错误、严重错误场景
  - [ ] 验收：所有错误显示友好提示

- [ ] **任务 1.2：更新 HTTP API 错误处理**
  - [ ] 创建统一错误处理函数
  - [ ] 在所有 API 方法中应用错误处理
  - [ ] 添加错误类型定义
  - [ ] 测试：引擎未启动、无效参数、网络错误场景
  - [ ] 验收：API 错误统一处理，显示友好提示

### 阶段 2：P1 推荐调整（✅完成标准）

- [ ] **任务 2.1：添加错误严重程度 UI 区分**
  - [ ] 更新错误事件处理器添加 severity UI 区分
  - [ ] 创建 severity 配置映射
  - [ ] 评估并扩展 Toast 组件（如需要）
  - [ ] 测试：critical、error、warning、info 场景
  - [ ] 验收：不同严重程度有不同 UI 表现

- [ ] **任务 2.2：创建错误建议展示组件**
  - [ ] 创建 ErrorSuggestionsDialog 组件
  - [ ] 创建错误状态管理
  - [ ] 在 Toast 中添加"查看详情"按钮
  - [ ] 实现复制功能
  - [ ] 测试：多条建议、复制、上下文展示场景
  - [ ] 验收：完整的错误信息可查看和复制

- [ ] **任务 2.3：根据错误代码执行特殊处理**
  - [ ] 创建错误代码处理映射
  - [ ] 扩展 Toast 支持 Action 按钮
  - [ ] 实现重试逻辑
  - [ ] 实现导航跳转
  - [ ] 测试：CONNECTION_FAILED、DEVICE_NOT_FOUND、CONFIG_ERROR 等场景
  - [ ] 验收：关键错误代码有特殊处理

### 阶段 3：P2 代码质量优化（✅完成标准）

- [ ] **任务 3.1：迁移到 useWSEvent Hook**
  - [ ] 迁移 RadioControl.tsx
  - [ ] 迁移 SpectrumDisplay.tsx
  - [ ] 迁移 RadioOperator.tsx
  - [ ] 迁移 FramesTable.tsx
  - [ ] 迁移 WebGLWaterfall.tsx
  - [ ] 迁移其他组件（5-8 个）
  - [ ] 测试：功能正常、无内存泄漏、依赖数组正确
  - [ ] 验收：所有组件迁移完成，代码简化

- [ ] **任务 3.2：统一 API 调用封装**
  - [ ] 创建 ApiClient 类
  - [ ] 实现统一错误处理
  - [ ] 实现重试机制（可选）
  - [ ] 实现 Loading 状态管理
  - [ ] 添加请求/响应拦截器
  - [ ] 更新 RadioService 使用 ApiClient
  - [ ] 测试：正常调用、错误处理、重试、Loading 状态
  - [ ] 验收：API 调用统一，代码简化

- [ ] **任务 3.3：更新项目文档**
  - [ ] 更新 packages/web/CLAUDE.md
  - [ ] 创建错误处理指南（可选）
  - [ ] 更新根目录 CLAUDE.md
  - [ ] 验收：文档完整准确

---

## 测试验收标准

### 功能测试

**错误提示测试**：
- [ ] 所有错误都显示用户友好的 userMessage
- [ ] 有操作建议时会显示
- [ ] 不同严重程度有不同的 UI 表现
- [ ] critical 错误不自动消失

**错误代码特殊处理测试**：
- [ ] CONNECTION_FAILED 显示重试按钮，点击可重试
- [ ] DEVICE_NOT_FOUND 显示前往设置按钮，点击可跳转
- [ ] CONFIG_ERROR 可高亮错误配置项
- [ ] INVALID_FREQUENCY 显示有效范围

**WebSocket 事件订阅测试**：
- [ ] 所有组件的事件订阅正常工作
- [ ] 使用 useWSEvent Hook 的组件功能正常
- [ ] 组件卸载后事件监听器被清理

**API 调用测试**：
- [ ] 所有 API 方法正常工作
- [ ] API 错误统一处理
- [ ] Loading 状态正确显示
- [ ] 重试机制正常工作（如果实现）

### 性能测试

**内存泄漏测试**：
- [ ] 使用 Chrome Memory Profiler 检测
- [ ] 组件挂载/卸载 10 次后堆大小稳定
- [ ] 事件监听器数量不累积

**渲染性能测试**：
- [ ] 错误提示显示流畅，无卡顿
- [ ] 高频事件（spectrum、meter）处理正常
- [ ] UI 响应及时

### 兼容性测试

**向后兼容测试**：
- [ ] 旧代码（未迁移的组件）仍然正常工作
- [ ] 手动管理的事件订阅正常工作
- [ ] 直接使用 fetch 的 API 调用正常工作

**浏览器兼容测试**：
- [ ] Chrome 最新版
- [ ] Firefox 最新版
- [ ] Safari 最新版（macOS）
- [ ] Edge 最新版

### 代码质量测试

**TypeScript 检查**：
- [ ] `yarn build` 无类型错误
- [ ] 所有新增代码有完整的类型定义

**Lint 检查**：
- [ ] `yarn lint` 无警告和错误
- [ ] 无 React Hooks 依赖警告

**单元测试**（如果项目有测试）：
- [ ] 所有单元测试通过
- [ ] 新增功能有相应的单元测试

---

## 常见问题和注意事项

### 1. 为什么需要同时适配 WebSocket 和 HTTP API 错误？

**原因**：
- WebSocket：实时事件通知（引擎状态变化、电台连接失败等）
- HTTP API：命令调用（启动/停止引擎、设置频率等）

两者都可能返回错误，需要统一处理以提供一致的用户体验。

### 2. userMessage 和 message 有什么区别？

| 字段 | 用途 | 受众 | 示例 |
|------|------|------|------|
| `message` | 技术错误信息 | 开发者、日志 | "digitalRadioEngine.start() 执行失败: Connection timeout" |
| `userMessage` | 用户友好提示 | 最终用户 | "无法连接到电台，请检查电台IP地址和网络连接" |

**最佳实践**：
- UI 中显示 `userMessage`
- Console 日志记录 `message`
- 错误报告工具（Sentry）记录完整的 `message` 和 `context`

### 3. 如何决定错误的 severity？

**决策树**：
```
是否导致系统崩溃或数据丢失？
  ├─ 是 → critical
  └─ 否 → 是否影响核心功能？
           ├─ 是 → error
           └─ 否 → 是否存在潜在问题？
                    ├─ 是 → warning
                    └─ 否 → info
```

**具体示例**：
- critical: 引擎启动严重失败、资源无法释放
- error: 电台连接失败、解码失败
- warning: 配置项缺失但有默认值、音频质量下降
- info: 操作成功提示、状态变更通知

### 4. suggestions 应该写什么内容？

**好的 suggestions**：
- ✅ 具体、可操作："检查电台IP地址是否正确（当前：192.168.1.100）"
- ✅ 多步骤："1. 确认电台已开机 2. 检查网络连接 3. 验证IP地址"
- ✅ 提供链接："前往设置页面检查配置"

**不好的 suggestions**：
- ❌ 太笼统："检查配置"
- ❌ 重复错误信息："连接失败"
- ❌ 技术术语："检查 TCP socket 连接状态"

### 5. 什么时候使用 ErrorSuggestionsDialog？

**使用场景**：
- 有 2 条以上的 suggestions
- 需要显示详细的错误上下文
- 用户需要复制错误信息报告问题

**不使用场景**：
- 只有 1 条或没有 suggestions（Toast 足够）
- 简单的提示性信息
- 高频出现的错误（避免打断用户）

### 6. useWSEvent 和手动管理哪个更好？

**推荐使用 useWSEvent**，因为：
- ✅ 自动清理，防止内存泄漏
- ✅ 代码更简洁
- ✅ 类型安全
- ✅ 依赖自动追踪

**手动管理的合理场景**：
- 需要动态添加/删除多个监听器
- 需要在回调中移除自己
- 特殊的生命周期需求

**注意**：即使使用手动管理，也必须配对调用 `onWSEvent` 和 `offWSEvent`。

### 7. ApiClient 是否需要支持取消请求？

**推荐支持**，特别是以下场景：
- 组件卸载时取消未完成的请求
- 用户导航到其他页面时取消旧请求
- 防止竞态条件（race condition）

**实现方式**：
- 使用 AbortController API
- 在 ApiClient 中集成
- 在组件卸载时自动取消

### 8. 错误重试会不会导致服务器压力？

**缓解策略**：
1. **指数退避**：重试延迟递增（1s, 2s, 4s）
2. **最大重试次数**：限制为 2-3 次
3. **有选择地重试**：仅重试网络错误和 5xx 错误，不重试 4xx
4. **用户可控**：critical 错误不自动重试，需要用户确认

### 9. 如何测试内存泄漏？

**手动测试步骤**：
1. 打开 Chrome DevTools → Memory 标签
2. 点击 "Take heap snapshot" 记录初始状态
3. 挂载/卸载目标组件 10 次
4. 手动触发 GC（点击垃圾桶图标）
5. 再次 "Take heap snapshot"
6. 比较两个快照，查看 "Detached DOM nodes" 和 "Listeners"
7. 如果数量显著增长，说明有内存泄漏

**自动化测试**（可选）：
- 使用 MemoryLeakDetector 工具（后端已添加）
- 编写单元测试检测事件监听器泄漏

### 10. 如何处理多个并发错误？

**策略**：
1. **错误队列**：同时出现多个错误时排队显示，避免 Toast 堆叠
2. **错误合并**：相同 code 的错误在短时间内只显示一次
3. **优先级**：critical 错误优先显示，覆盖低优先级错误

**实现建议**：
```typescript
// TODO: 错误队列管理
// 维护一个错误队列
// 同一时间只显示一个 critical 错误
// 相同 code 的错误 5 秒内去重
```

### 11. 前端如何处理后端未预期的错误格式？

**容错策略**：
```typescript
// 优雅降级
const userMessage = error.userMessage || error.message || '发生未知错误';
const suggestions = error.suggestions || [];
const severity = error.severity || 'error';
const code = error.code || 'UNKNOWN_ERROR';
```

**最佳实践**：
- 始终提供回退值
- 记录格式不符合预期的错误
- 通知后端团队修复格式问题

### 12. 如何在开发环境和生产环境中使用不同的错误处理策略？

**策略**：
```typescript
// 开发环境：显示详细的技术错误
if (import.meta.env.DEV) {
  console.error('[详细错误]', {
    message: error.message,
    code: error.code,
    context: error.context,
    stack: error.stack
  });

  // 可选：在 Toast 中显示技术错误（仅开发环境）
  toast.error(`[DEV] ${error.message}`, {
    description: error.code
  });
}

// 生产环境：仅显示用户友好提示
toast.error(error.userMessage || '操作失败，请稍后重试');
```

### 13. 如何避免错误提示对用户造成困扰？

**用户体验原则**：
1. **清晰但不惊慌**：使用友好的语言，避免"错误"、"失败"等负面词汇
   - ❌ "严重错误！系统崩溃！"
   - ✅ "无法完成操作，请检查配置"

2. **提供解决方案**：不仅说出问题，还要指出方向
   - ❌ "连接失败"
   - ✅ "无法连接到电台，请检查电台IP地址和网络连接"

3. **适当的持续时间**：
   - 信息性提示：2-3 秒
   - 需要用户注意的错误：5 秒
   - 严重错误：不自动消失，需要用户确认

4. **避免重复**：相同错误在短时间内不重复显示

---

## 实施时间表（建议）

### Week 1：P0 必须调整

| 天 | 任务 | 预计时间 |
|----|------|---------|
| Day 1 | 任务 1.1：更新 WebSocket ERROR 事件处理器 | 2-3h |
| Day 1-2 | 任务 1.2：更新 HTTP API 错误处理 | 2-3h |
| Day 2 | 测试和验收 | 1-2h |

### Week 2：P1 推荐调整

| 天 | 任务 | 预计时间 |
|----|------|---------|
| Day 3 | 任务 2.1：添加错误严重程度 UI 区分 | 2-3h |
| Day 4 | 任务 2.2：创建错误建议展示组件 | 3-4h |
| Day 5 | 任务 2.3：根据错误代码执行特殊处理 | 2-3h |
| Day 5 | 测试和验收 | 1-2h |

### Week 3：P2 代码质量优化

| 天 | 任务 | 预计时间 |
|----|------|---------|
| Day 6-7 | 任务 3.1：迁移到 useWSEvent Hook（6-8 个组件） | 6-8h |
| Day 8 | 任务 3.2：统一 API 调用封装 | 4-6h |
| Day 9 | 任务 3.3：更新项目文档 | 2-3h |
| Day 9-10 | 全面测试和验收 | 3-4h |

**总计**：20-24 小时（约 2-3 周）

---

## 参考资源

### 相关文档
- 架构重构设计：`docs/architecture-refactor-design.md`
- 前端集成指南：`docs/frontend-integration-day14.md`
- Web 包文档：`packages/web/CLAUDE.md`
- Contracts 包文档：`packages/contracts/CLAUDE.md`

### 技术栈文档
- React Hooks：https://react.dev/reference/react
- HeroUI：https://www.heroui.com/
- TypeScript：https://www.typescriptlang.org/

### 错误处理最佳实践
- 用户友好错误消息：https://uxdesign.cc/how-to-write-error-messages-that-dont-suck-601c4f5e62f5
- 错误处理 UX：https://www.nngroup.com/articles/error-message-guidelines/

---

## 版本历史

| 版本 | 日期 | 变更内容 | 作者 |
|------|------|---------|------|
| v1.1 | 2025-11-03 | 补充 @heroui/toast 使用指南章节；添加阶段1（P0）任务的完整实现代码；包含 ApiError 类、错误处理函数、errorToast 工具函数的完整实现 | Claude |
| v1.0 | 2025-11-03 | 初始版本，完整方案（P0+P1+P2） | Claude |

---

## 反馈和改进

如果在实施过程中遇到问题或有改进建议，请：
1. 记录问题和上下文
2. 更新本文档的"常见问题"部分
3. 提交 Issue 或 Pull Request

---

**准备开始实施了吗？让我们从阶段1（P0必须调整）开始！** 🚀
