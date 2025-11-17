# 前端对接文档 - Day14 错误处理优化

> **版本**: 1.1
> **日期**: 2025-11-03
> **适用范围**: Day14 服务层完善后的前端适配指南（包含9个HTTP API路由详细说明）

---

## 📋 目录

1. [变更概述](#变更概述)
2. [WebSocket 错误消息格式变更](#websocket-错误消息格式变更)
3. [HTTP API 错误响应格式变更](#http-api-错误响应格式变更)
4. [HTTP API 路由详细说明](#http-api-路由详细说明)
   - [操作员管理 API](#1-操作员管理-api-apioperators)
   - [WaveLog 同步 API](#2-wavelog-同步-api-apiwavelog)
   - [日志本管理 API](#3-日志本管理-api-apilogbooks)
   - [时隙包管理 API](#4-时隙包管理-api-api)
   - [模式管理 API](#5-模式管理-api-apimode)
   - [存储管理 API](#6-存储管理-api-apistorage)
   - [音频设备管理 API](#7-音频设备管理-api-apiaudio)
   - [电台控制 API](#8-电台控制-api-apiradio)
   - [设置管理 API](#9-设置管理-api-apisettings)
5. [前端适配指南](#前端适配指南)
6. [示例代码](#示例代码)
7. [测试建议](#测试建议)

---

## 变更概述

### 🎯 优化目标

Day14 对后端的错误处理进行了全面优化，主要改进包括：

1. **统一的错误处理**: 所有 WebSocket 命令处理器使用统一的错误处理模式
2. **友好的错误提示**: 提供用户可读的错误消息和操作建议
3. **错误后状态同步**: 确保前端在错误发生后能收到最新的系统状态
4. **HTTP 状态码映射**: Fastify API 返回语义化的 HTTP 状态码

### ✨ 主要优势

- **更好的用户体验**: 用户看到的是友好的提示，而不是技术错误信息
- **更准确的状态**: 错误后前端会自动收到最新的系统状态
- **更强的可调试性**: 详细的错误代码、严重程度和建议

---

## WebSocket 错误消息格式变更

### 🔴 旧格式（Day14 之前）

```typescript
// 旧的错误消息格式
{
  type: 'error',
  data: {
    message: 'digitalRadioEngine.start() 执行失败: ICOM WLAN 连接失败',
    code: 'START_ENGINE_ERROR'  // 字符串常量
  }
}
```

**问题**：
- ❌ 错误消息不友好（包含技术细节）
- ❌ 缺少操作建议
- ❌ 没有错误严重程度信息
- ❌ 错误后前端状态可能不同步

---

### 🟢 新格式（Day14 之后）

```typescript
// 新的错误消息格式
{
  type: 'error',
  data: {
    // 原始技术错误信息（供日志记录）
    message: 'digitalRadioEngine.start() 执行失败: ICOM WLAN 连接失败',

    // 用户友好的错误提示（供 UI 显示）
    userMessage: '无法连接到电台',

    // 标准化的错误代码（枚举值）
    code: 'CONNECTION_FAILED',  // RadioErrorCode 枚举

    // 错误严重程度
    severity: 'error',  // 'critical' | 'error' | 'warning' | 'info'

    // 操作建议列表
    suggestions: [
      '检查电台是否开机',
      '检查网络连接',
      '检查配置是否正确',
      '尝试重启电台'
    ],

    // 错误发生时间戳
    timestamp: 1730534400000,

    // 可选：错误上下文
    context: {
      command: 'startEngine'  // 触发错误的命令
    }
  }
}

// 🔔 紧接着会收到系统状态更新
{
  type: 'systemStatus',
  data: {
    isRunning: false,
    isDecoding: false,
    // ... 完整的系统状态
  }
}
```

**优势**：
- ✅ 用户友好的错误提示（`userMessage`）
- ✅ 详细的操作建议（`suggestions`）
- ✅ 标准化的错误代码（`code`）
- ✅ 错误严重程度（`severity`）
- ✅ 自动的状态同步（紧接着收到 `systemStatus`）

---

## HTTP API 错误响应格式变更

### 🔴 旧格式（Day14 之前）

Fastify 默认的错误响应，不够友好。

---

### 🟢 新格式（Day14 之后）

```typescript
// HTTP 状态码: 根据错误类型返回语义化状态码
// 响应体格式:
{
  success: false,
  error: {
    code: 'CONNECTION_FAILED',  // RadioErrorCode 枚举
    message: '连接失败: User disconnect()',  // 技术错误信息
    userMessage: '无法连接到电台',  // 用户友好提示
    severity: 'error',  // 错误严重程度
    suggestions: [  // 操作建议
      '检查电台是否开机',
      '检查网络连接',
      '检查配置是否正确',
      '尝试重启电台'
    ],
    timestamp: 1730534400000,  // 时间戳
    context: {  // 可选的错误上下文
      // 额外信息
    }
  }
}
```

### HTTP 状态码映射

| HTTP 状态码 | 错误类型 | 示例错误代码 |
|------------|---------|------------|
| **400** Bad Request | 配置/操作错误 | `INVALID_CONFIG`, `INVALID_OPERATION`, `UNSUPPORTED_MODE` |
| **404** Not Found | 设备未找到 | `DEVICE_NOT_FOUND`, `RESOURCE_UNAVAILABLE` |
| **409** Conflict | 状态冲突 | `ALREADY_RUNNING`, `NOT_RUNNING`, `NOT_INITIALIZED` |
| **500** Internal Server Error | 服务器错误 | `DEVICE_ERROR`, `AUDIO_DEVICE_ERROR`, `PTT_ACTIVATION_FAILED` |
| **503** Service Unavailable | 服务不可用 | `CONNECTION_FAILED`, `DEVICE_BUSY`, `RECONNECT_MAX_ATTEMPTS` |

---

## HTTP API 路由详细说明

以下是 Day14 重构后的所有 HTTP API 路由及其错误处理详情。

---

### 1. 操作员管理 API (`/api/operators`)

**路由文件**: `packages/server/src/routes/operators.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/operators` | 获取所有操作员配置 |
| GET | `/api/operators/:id` | 获取指定操作员配置 |
| POST | `/api/operators` | 创建新操作员 |
| PUT | `/api/operators/:id` | 更新操作员配置 |
| DELETE | `/api/operators/:id` | 删除操作员 |
| POST | `/api/operators/:id/start` | 启动操作员发射 |
| POST | `/api/operators/:id/stop` | 停止操作员发射 |
| GET | `/api/operators/:id/status` | 获取操作员运行状态 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `RESOURCE_UNAVAILABLE` | 404 | 操作员ID不存在 | "操作员 xxx 不存在" | 检查操作员ID是否正确、使用 GET /api/operators 获取所有操作员列表 |
| `INVALID_CONFIG` | 400 | 创建操作员时数据格式错误 | "请求数据格式不正确" | 检查必填字段、确保频率值在有效范围内 (0-4000 Hz)、参考 API 文档中的示例格式 |
| `INVALID_OPERATION` | 400 | 删除默认操作员 | "操作员删除受限: 不能删除默认操作员" | 检查是否为默认操作员（默认操作员不能删除）、确保操作员未在运行中 |

#### 错误响应示例

```typescript
// 示例1: 操作员不存在
// GET /api/operators/nonexistent-id
{
  "success": false,
  "error": {
    "code": "RESOURCE_UNAVAILABLE",
    "message": "操作员配置不存在: nonexistent-id",
    "userMessage": "操作员 nonexistent-id 不存在",
    "severity": "warning",
    "suggestions": [
      "检查操作员ID是否正确",
      "使用 GET /api/operators 获取所有操作员列表"
    ],
    "timestamp": 1730534400000
  }
}

// 示例2: 创建操作员时数据格式错误
// POST /api/operators
{
  "success": false,
  "error": {
    "code": "INVALID_CONFIG",
    "message": "操作员配置数据格式错误",
    "userMessage": "请求数据格式不正确",
    "severity": "warning",
    "suggestions": [
      "检查必填字段: myCallsign",
      "确保频率值在有效范围内 (0-4000 Hz)",
      "参考 API 文档中的示例格式"
    ],
    "timestamp": 1730534400000,
    "context": {
      "errors": [ /* Zod 验证错误详情 */ ]
    }
  }
}
```

---

### 2. WaveLog 同步 API (`/api/wavelog`)

**路由文件**: `packages/server/src/routes/wavelog.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/wavelog/config` | 获取 WaveLog 配置 |
| PUT | `/api/wavelog/config` | 更新 WaveLog 配置 |
| POST | `/api/wavelog/test` | 测试 WaveLog 连接 |
| POST | `/api/wavelog/config/reset` | 重置 WaveLog 配置 |
| POST | `/api/wavelog/upload` | 手动上传 QSO 记录 |
| POST | `/api/wavelog/sync` | 执行同步操作 |
| POST | `/api/wavelog/diagnose` | 诊断连接问题 |
| GET | `/api/wavelog/status` | 获取同步状态 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `NOT_INITIALIZED` | 409 | WaveLog 服务未初始化 | "请先配置 WaveLog 设置" | 在设置页面配置 WaveLog URL 和 API 密钥、确保 WaveLog 服务已启用 |
| `CONNECTION_FAILED` | 503 | 连接 WaveLog 服务器失败 | "无法连接到 WaveLog 服务器" | 检查 WaveLog URL 是否正确、检查网络连接、确认 WaveLog 服务器运行状态 |
| `INVALID_CONFIG` | 400 | WaveLog 配置数据格式错误 | "WaveLog 配置格式不正确" | 检查 URL 格式、验证 API 密钥有效性 |
| `INVALID_OPERATION` | 400 | 不支持的同步操作类型 | "不支持的同步操作类型" | 支持的操作类型：download（下载）、upload（上传）、full_sync（完整同步） |

#### 错误响应示例

```typescript
// 示例: WaveLog 服务未初始化
// POST /api/wavelog/sync
{
  "success": false,
  "error": {
    "code": "NOT_INITIALIZED",
    "message": "WaveLog服务未初始化",
    "userMessage": "请先配置WaveLog设置",
    "severity": "warning",
    "suggestions": [
      "在设置页面配置WaveLog URL和API密钥",
      "确保WaveLog服务已启用"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 3. 日志本管理 API (`/api/logbooks`)

**路由文件**: `packages/server/src/routes/logbooks.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/logbooks` | 获取所有日志本列表 |
| GET | `/api/logbooks/:id` | 获取特定日志本详情 |
| POST | `/api/logbooks` | 创建新日志本 |
| PUT | `/api/logbooks/:id` | 更新日志本信息 |
| DELETE | `/api/logbooks/:id` | 删除日志本 |
| POST | `/api/logbooks/:id/connect` | 连接操作员到日志本 |
| POST | `/api/logbooks/disconnect/:operatorId` | 断开操作员与日志本的连接 |
| GET | `/api/logbooks/:id/qsos` | 查询日志本中的 QSO 记录 |
| GET | `/api/logbooks/:id/export` | 导出日志本数据 |
| POST | `/api/logbooks/:id/import` | 导入数据到日志本 |
| PUT | `/api/logbooks/:id/qsos/:qsoId` | 更新单条 QSO 记录 |
| DELETE | `/api/logbooks/:id/qsos/:qsoId` | 删除单条 QSO 记录 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `RESOURCE_UNAVAILABLE` | 404 | 日志本或 QSO 记录不存在 | "未找到指定的日志本" | 检查日志本ID是否正确、查看可用的日志本列表 |
| `INVALID_CONFIG` | 400 | 创建/更新日志本时数据格式错误 | "请求数据格式不正确" | 检查字段类型是否正确、参考 API 文档中的示例 |
| `INVALID_OPERATION` | 400 | 导入数据失败 | "数据导入失败" | 检查导入数据格式、确保数据完整性 |

#### 错误响应示例

```typescript
// 示例: 日志本不存在
// GET /api/logbooks/invalid-id
{
  "success": false,
  "error": {
    "code": "RESOURCE_UNAVAILABLE",
    "message": "日志本 invalid-id 不存在",
    "userMessage": "未找到指定的日志本",
    "severity": "warning",
    "suggestions": [
      "检查日志本ID是否正确",
      "查看可用的日志本列表"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 4. 时隙包管理 API (`/api`)

**路由文件**: `packages/server/src/routes/slotpack.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/slotpacks` | 获取所有活跃的时隙包 |
| GET | `/api/slotpacks/:slotId` | 获取指定时隙包 |
| GET | `/api/slotpacks/stats` | 获取时隙包统计信息 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `RESOURCE_UNAVAILABLE` | 404 | 时隙包不存在 | "未找到指定的时隙包" | 检查时隙ID是否正确、查看活跃的时隙包列表 |
| `INVALID_OPERATION` | 400 | 获取时隙包操作失败 | "获取时隙包失败" | 刷新页面重试、检查系统状态 |

#### 错误响应示例

```typescript
// 示例: 时隙包不存在
// GET /api/slotpacks/invalid-slot-id
{
  "success": false,
  "error": {
    "code": "RESOURCE_UNAVAILABLE",
    "message": "时隙包 invalid-slot-id 未找到",
    "userMessage": "未找到指定的时隙包",
    "severity": "warning",
    "suggestions": [
      "检查时隙ID是否正确",
      "查看活跃的时隙包列表"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 5. 模式管理 API (`/api/mode`)

**路由文件**: `packages/server/src/routes/mode.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/mode` | 获取所有可用模式 |
| GET | `/api/mode/current` | 获取当前模式 |
| POST | `/api/mode/switch` | 切换模式 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `INVALID_OPERATION` | 400 | 切换模式失败 | "模式切换失败" | 检查模式是否有效、确保系统状态允许切换 |

#### 错误响应示例

```typescript
// 示例: 切换到不支持的模式
// POST /api/mode/switch
{
  "success": false,
  "error": {
    "code": "INVALID_OPERATION",
    "message": "模式切换失败: 不支持的模式 INVALID",
    "userMessage": "模式切换失败",
    "severity": "error",
    "suggestions": [
      "使用 GET /api/mode 查看可用模式",
      "检查模式名称拼写是否正确"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 6. 存储管理 API (`/api/storage`)

**路由文件**: `packages/server/src/routes/storage.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/storage/status` | 获取持久化存储状态 |
| POST | `/api/storage/toggle` | 启用/禁用持久化存储 |
| POST | `/api/storage/flush` | 强制刷新缓冲区 |
| GET | `/api/storage/dates` | 获取可用的存储日期 |
| GET | `/api/storage/records/:date` | 读取指定日期的记录 |
| GET | `/api/storage/summary` | 获取存储统计摘要 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `INVALID_CONFIG` | 400 | 参数格式错误 | "请提供有效的参数" | 检查参数类型和格式、参考 API 文档 |
| `INVALID_OPERATION` | 400 | 存储操作失败 | "存储操作失败" | 检查存储权限、确保磁盘空间充足 |

#### 错误响应示例

```typescript
// 示例: 日期格式错误
// GET /api/storage/records/2025-13-40
{
  "success": false,
  "error": {
    "code": "INVALID_CONFIG",
    "message": "日期格式错误: 2025-13-40",
    "userMessage": "日期格式不正确",
    "severity": "warning",
    "suggestions": [
      "日期格式应为 YYYY-MM-DD（例如：2025-11-02）"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 7. 音频设备管理 API (`/api/audio`)

**路由文件**: `packages/server/src/routes/audio.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/audio/devices` | 获取所有音频设备 |
| GET | `/api/audio/settings` | 获取当前音频设备设置 |
| POST | `/api/audio/settings` | 更新音频设备设置 |
| POST | `/api/audio/settings/reset` | 重置音频设备设置 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `DEVICE_NOT_FOUND` | 404 | 音频设备不存在 | "找不到指定的音频设备" | 检查设备名称是否正确、查看可用的音频设备列表、确保设备已连接 |
| `AUDIO_DEVICE_ERROR` | 500 | 获取音频设备列表失败 | "音频设备操作失败" | 检查音频驱动、重启应用、确保设备未被其他程序占用 |
| `INVALID_CONFIG` | 400 | 音频设置格式错误 | "音频设备设置格式不正确" | 检查参数类型、参考 API 文档中的示例 |

#### 错误响应示例

```typescript
// 示例: 音频设备不存在
// POST /api/audio/settings
{
  "success": false,
  "error": {
    "code": "DEVICE_NOT_FOUND",
    "message": "指定的输入设备 \"Nonexistent Device\" 不存在",
    "userMessage": "找不到指定的音频输入设备",
    "severity": "warning",
    "suggestions": [
      "检查设备名称是否正确",
      "查看可用的音频设备列表",
      "确保设备已连接"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 8. 电台控制 API (`/api/radio`)

**路由文件**: `packages/server/src/routes/radio.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/radio/config` | 获取电台配置 |
| POST | `/api/radio/config` | 更新电台配置 |
| GET | `/api/radio/rigs` | 获取支持的电台型号列表 |
| GET | `/api/radio/serial-ports` | 获取可用串口列表 |
| GET | `/api/radio/frequencies` | 获取频率预设 |
| GET | `/api/radio/last-frequency` | 获取上次选择的频率 |
| POST | `/api/radio/frequency` | 设置电台频率 |
| POST | `/api/radio/test` | 测试电台连接 |
| POST | `/api/radio/test-ptt` | 测试 PTT 功能 |
| GET | `/api/radio/status` | 获取电台连接状态 |
| POST | `/api/radio/connect` | 手动连接电台 |
| POST | `/api/radio/disconnect` | 断开电台连接 |
| POST | `/api/radio/manual-reconnect` | 手动重连电台 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `INVALID_CONFIG` | 400 | 电台配置错误 | "电台配置不正确" | 检查配置参数、选择正确的电台型号、验证串口或网络设置 |
| `INVALID_OPERATION` | 400 | 频率设置失败 | "无法设置电台频率" | 检查电台连接是否正常、确认频率在电台支持的范围内、尝试重新连接电台 |
| `CONNECTION_FAILED` | 503 | 电台连接失败 | "无法连接到电台" | 检查电台是否开机、检查串口或网络连接、验证配置参数 |

#### 错误响应示例

```typescript
// 示例: 频率参数无效
// POST /api/radio/frequency
{
  "success": false,
  "error": {
    "code": "INVALID_CONFIG",
    "message": "无效的频率值: undefined",
    "userMessage": "请提供有效的频率值",
    "severity": "warning",
    "suggestions": [
      "确认频率参数是否为数字类型",
      "检查频率范围是否在电台支持的范围内"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 9. 设置管理 API (`/api/settings`)

**路由文件**: `packages/server/src/routes/settings.ts`

#### 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/api/settings/ft8` | 获取 FT8 配置 |
| PUT | `/api/settings/ft8` | 更新 FT8 配置 |

#### 常见错误代码

| 错误代码 | HTTP状态码 | 场景示例 | 用户提示 | 建议操作 |
|---------|-----------|---------|---------|---------|
| `INVALID_CONFIG` | 400 | FT8 配置格式错误 | "配置格式不正确" | 检查配置参数类型、参考 API 文档 |
| `INVALID_OPERATION` | 400 | 配置操作失败 | "配置操作失败" | 检查系统状态、重试操作 |

#### 错误响应示例

```typescript
// 示例: FT8 配置更新失败
// PUT /api/settings/ft8
{
  "success": false,
  "error": {
    "code": "INVALID_CONFIG",
    "message": "FT8配置更新失败: 无效的参数类型",
    "userMessage": "配置格式不正确",
    "severity": "warning",
    "suggestions": [
      "检查配置参数类型是否正确",
      "参考 API 文档中的示例格式"
    ],
    "timestamp": 1730534400000
  }
}
```

---

### 错误处理最佳实践

#### 1. 统一的错误响应格式

所有 HTTP API 错误都遵循相同的格式：

```typescript
{
  success: false,
  error: {
    code: string,           // RadioErrorCode 枚举值
    message: string,        // 技术错误信息（供日志记录）
    userMessage: string,    // 用户友好提示（供 UI 显示）
    severity: string,       // 错误严重程度
    suggestions: string[],  // 操作建议列表
    timestamp: number,      // 错误发生时间戳
    context?: object        // 可选的错误上下文
  }
}
```

#### 2. HTTP 状态码使用规范

- **400 Bad Request**: 客户端请求错误（配置错误、参数错误）
- **404 Not Found**: 资源不存在（设备未找到、记录不存在）
- **409 Conflict**: 状态冲突（已在运行、未初始化）
- **500 Internal Server Error**: 服务器内部错误（设备错误、系统错误）
- **503 Service Unavailable**: 服务不可用（连接失败、设备忙）

#### 3. 前端处理建议

```typescript
// 统一的 API 错误处理函数
async function handleApiCall(apiFunction: () => Promise<any>) {
  try {
    return await apiFunction();
  } catch (error) {
    if (error.response) {
      const { error: errorData } = error.response.data;

      // 显示用户友好的错误消息
      toast.error(errorData.userMessage, {
        description: errorData.suggestions[0],
        duration: errorData.severity === 'critical' ? null : 5000,
      });

      // 记录技术细节
      console.error('[API Error]', {
        code: errorData.code,
        message: errorData.message,
        context: errorData.context,
      });

      // 根据错误代码执行特殊处理
      handleSpecificError(errorData.code);
    }

    throw error;
  }
}
```

---

## 前端适配指南

### 📌 必须适配的内容

#### 1. **更新 WebSocket ERROR 事件处理器**

**位置**: `packages/web/src/store/radioStore.tsx` 或相关组件

**变更前**:
```typescript
wsClient.onWSEvent('error', (data: { message: string; code: string }) => {
  // 旧的处理方式
  console.error('错误:', data.message);
  toast.error(data.message);  // ❌ 显示技术错误信息
});
```

**变更后**:
```typescript
interface ErrorData {
  message: string;        // 技术错误信息（供日志）
  userMessage: string;    // 用户友好提示（供 UI 显示）
  code: string;           // 错误代码
  severity: 'critical' | 'error' | 'warning' | 'info';
  suggestions: string[];  // 操作建议
  timestamp: number;      // 时间戳
  context?: Record<string, unknown>;  // 可选上下文
}

wsClient.onWSEvent('error', (data: ErrorData) => {
  // 新的处理方式
  console.error('[错误]', {
    code: data.code,
    message: data.message,  // 记录技术细节
    context: data.context,
  });

  // ✅ 显示用户友好的错误提示
  const displayMessage = data.userMessage || data.message;

  // 根据严重程度选择不同的提示样式
  switch (data.severity) {
    case 'critical':
      toast.error(displayMessage, {
        duration: null,  // 需要手动关闭
        action: data.suggestions.length > 0 ? {
          label: '查看建议',
          onClick: () => showSuggestions(data.suggestions)
        } : undefined
      });
      break;
    case 'error':
      toast.error(displayMessage, { duration: 5000 });
      break;
    case 'warning':
      toast.warning(displayMessage, { duration: 3000 });
      break;
    case 'info':
      toast.info(displayMessage, { duration: 2000 });
      break;
  }
});
```

---

#### 2. **更新 HTTP API 错误处理**

**位置**: `packages/core/src/RadioService.ts` 或相关 API 调用

**变更前**:
```typescript
try {
  const response = await fetch('/api/radio/start', { method: 'POST' });
  const data = await response.json();
  return data;
} catch (error) {
  console.error('启动失败:', error);
  throw error;
}
```

**变更后**:
```typescript
interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    userMessage: string;
    severity: string;
    suggestions: string[];
    timestamp: number;
    context?: Record<string, unknown>;
  };
}

async function startEngine() {
  try {
    const response = await fetch('/api/radio/start', { method: 'POST' });

    if (!response.ok) {
      const errorData: ApiErrorResponse = await response.json();

      // 创建友好的错误对象
      const error = new Error(errorData.error.userMessage);
      Object.assign(error, {
        code: errorData.error.code,
        severity: errorData.error.severity,
        suggestions: errorData.error.suggestions,
        originalMessage: errorData.error.message,
      });

      throw error;
    }

    return await response.json();
  } catch (error) {
    console.error('[API错误]', error);

    // 显示用户友好的错误提示
    if (error.userMessage) {
      toast.error(error.userMessage);

      // 如果有建议，可以显示
      if (error.suggestions?.length > 0) {
        console.log('建议:', error.suggestions);
      }
    } else {
      toast.error('操作失败，请稍后重试');
    }

    throw error;
  }
}
```

---

### 📌 可选优化内容

#### 3. **添加错误建议展示组件**

```typescript
// ErrorSuggestionsDialog.tsx
interface ErrorSuggestionsProps {
  suggestions: string[];
  onClose: () => void;
}

export function ErrorSuggestionsDialog({ suggestions, onClose }: ErrorSuggestionsProps) {
  return (
    <Dialog open onClose={onClose}>
      <DialogTitle>💡 解决建议</DialogTitle>
      <DialogContent>
        <List>
          {suggestions.map((suggestion, index) => (
            <ListItem key={index}>
              <ListItemIcon>
                <CheckCircleIcon />
              </ListItemIcon>
              <ListItemText primary={suggestion} />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>知道了</Button>
      </DialogActions>
    </Dialog>
  );
}
```

---

#### 4. **根据错误代码进行特殊处理**

```typescript
wsClient.onWSEvent('error', (data: ErrorData) => {
  // 根据错误代码执行特殊逻辑
  switch (data.code) {
    case 'CONNECTION_FAILED':
      // 显示重连按钮
      radioDispatch({
        type: 'SHOW_RECONNECT_BUTTON',
        payload: { errorMessage: data.userMessage }
      });
      break;

    case 'DEVICE_NOT_FOUND':
      // 引导用户到设备选择页面
      navigate('/settings/audio');
      toast.error(data.userMessage);
      break;

    case 'ALREADY_RUNNING':
      // 状态冲突，刷新系统状态
      radioService.getStatus();
      toast.warning(data.userMessage);
      break;

    default:
      // 默认错误处理
      toast.error(data.userMessage);
  }
});
```

---

#### 5. **错误严重程度的 UI 区分**

```typescript
// 根据严重程度使用不同的 Toast 样式
function showError(data: ErrorData) {
  const config = {
    critical: {
      icon: '🔴',
      duration: null,  // 需要手动关闭
      variant: 'destructive',
    },
    error: {
      icon: '❌',
      duration: 5000,
      variant: 'destructive',
    },
    warning: {
      icon: '⚠️',
      duration: 3000,
      variant: 'warning',
    },
    info: {
      icon: 'ℹ️',
      duration: 2000,
      variant: 'default',
    },
  }[data.severity];

  toast({
    title: `${config.icon} ${data.userMessage}`,
    description: data.suggestions?.[0],  // 显示第一条建议
    variant: config.variant,
    duration: config.duration,
  });
}
```

---

## 示例代码

### 完整的 WebSocket 错误处理示例

```typescript
// packages/web/src/store/radioStore.tsx

import { useEffect } from 'react';
import { toast } from '@/components/ui/use-toast';

interface ErrorData {
  message: string;
  userMessage: string;
  code: string;
  severity: 'critical' | 'error' | 'warning' | 'info';
  suggestions: string[];
  timestamp: number;
  context?: Record<string, unknown>;
}

export function RadioProvider({ children }: { children: React.ReactNode }) {
  const radioService = useRadioService();
  const [state, dispatch] = useReducer(radioReducer, initialState);

  useEffect(() => {
    const wsClient = radioService.wsClientInstance;

    // 📊 Day14：新的错误处理
    const handleError = (data: ErrorData) => {
      console.error('[WebSocket错误]', {
        code: data.code,
        severity: data.severity,
        message: data.message,
        userMessage: data.userMessage,
        suggestions: data.suggestions,
        context: data.context,
        timestamp: new Date(data.timestamp).toISOString(),
      });

      // 更新状态（记录最后的错误）
      dispatch({
        type: 'SET_LAST_ERROR',
        payload: {
          code: data.code,
          message: data.userMessage,
          timestamp: data.timestamp,
        },
      });

      // 根据严重程度显示不同的 Toast
      const severityConfig = {
        critical: { duration: null, variant: 'destructive' as const },
        error: { duration: 5000, variant: 'destructive' as const },
        warning: { duration: 3000, variant: 'default' as const },
        info: { duration: 2000, variant: 'default' as const },
      };

      const config = severityConfig[data.severity];

      toast({
        title: data.userMessage,
        description: data.suggestions.length > 0
          ? `💡 ${data.suggestions[0]}`
          : undefined,
        variant: config.variant,
        duration: config.duration,
        action: data.suggestions.length > 1 ? {
          label: '查看更多建议',
          onClick: () => {
            dispatch({
              type: 'SHOW_SUGGESTIONS_DIALOG',
              payload: { suggestions: data.suggestions },
            });
          },
        } : undefined,
      });

      // 特殊错误代码的处理
      if (data.code === 'CONNECTION_FAILED') {
        dispatch({ type: 'SET_RECONNECT_AVAILABLE', payload: true });
      }
    };

    wsClient.onWSEvent('error', handleError);

    return () => {
      wsClient.offWSEvent('error', handleError);
    };
  }, [radioService]);

  return (
    <RadioContext.Provider value={{ state, dispatch }}>
      {children}
    </RadioContext.Provider>
  );
}
```

---

### HTTP API 错误处理示例

```typescript
// packages/core/src/RadioService.ts

export class RadioService {
  private async handleApiRequest<T>(
    url: string,
    options?: RequestInit
  ): Promise<T> {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      if (!response.ok) {
        // 📊 Day14：解析新的错误格式
        const errorData = await response.json();

        if (errorData.success === false && errorData.error) {
          const error = new Error(errorData.error.userMessage);
          Object.assign(error, {
            code: errorData.error.code,
            severity: errorData.error.severity,
            suggestions: errorData.error.suggestions,
            originalMessage: errorData.error.message,
            httpStatus: response.status,
          });
          throw error;
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[API请求失败]', error);
      throw error;
    }
  }

  async startEngine(): Promise<void> {
    await this.handleApiRequest('/api/radio/start', {
      method: 'POST',
    });
  }
}
```

---

## 测试建议

### 1. **WebSocket 错误测试**

测试所有命令的错误场景，确保前端能正确处理：

```typescript
// 测试启动引擎失败
await wsClient.send('startEngine');
// 预期收到:
// 1. ERROR 事件（包含 userMessage、suggestions）
// 2. SYSTEM_STATUS 事件（isRunning: false）

// 测试设置模式失败
await wsClient.send('setMode', { mode: { name: 'INVALID' } });
// 预期收到:
// 1. ERROR 事件（code: 'UNSUPPORTED_MODE'）
// 2. SYSTEM_STATUS 事件
```

---

### 2. **HTTP API 错误测试**

```typescript
// 测试 404 错误
try {
  await radioService.getDeviceInfo('NONEXISTENT_DEVICE');
} catch (error) {
  expect(error.code).toBe('DEVICE_NOT_FOUND');
  expect(error.userMessage).toBeTruthy();
  expect(error.suggestions).toBeInstanceOf(Array);
}

// 测试 503 错误
try {
  await radioService.startEngine();  // 电台未连接
} catch (error) {
  expect(error.code).toBe('CONNECTION_FAILED');
  expect(error.httpStatus).toBe(503);
}
```

---

### 3. **UI 测试检查清单**

- [ ] 错误 Toast 显示用户友好的消息（`userMessage`）
- [ ] 严重错误（critical）不会自动消失
- [ ] 显示操作建议（至少第一条）
- [ ] 错误后系统状态正确更新
- [ ] 特殊错误代码有对应的 UI 反馈（如 CONNECTION_FAILED 显示重连按钮）
- [ ] 错误日志包含完整的技术信息（`message`、`code`、`context`）

---

## 错误代码参考

### 常见错误代码

| 错误代码 | 含义 | 用户提示示例 | 建议操作 |
|---------|------|------------|---------|
| `CONNECTION_FAILED` | 连接失败 | "无法连接到电台" | 检查电台是否开机、网络连接 |
| `DEVICE_NOT_FOUND` | 设备未找到 | "未找到音频设备" | 检查设备连接、选择其他设备 |
| `ALREADY_RUNNING` | 已在运行 | "系统已在运行" | 刷新页面或停止后重试 |
| `NOT_RUNNING` | 未运行 | "系统未运行" | 先启动系统 |
| `AUDIO_DEVICE_ERROR` | 音频设备错误 | "音频设备操作失败" | 检查音频设备、重启应用 |
| `PTT_ACTIVATION_FAILED` | PTT 激活失败 | "无法激活发射（PTT）" | 检查电台连接、PTT 配置 |
| `INVALID_OPERATION` | 无效操作 | "当前状态不允许此操作" | 检查系统状态 |
| `UNSUPPORTED_MODE` | 不支持的模式 | "不支持的模式" | 选择有效的模式 |

完整的错误代码定义见：`packages/server/src/utils/errors/RadioError.ts`

---

## 向后兼容性

### 兼容性保证

✅ **完全兼容**：旧的前端代码仍然可以工作

- 如果前端只使用 `data.message`，仍然可以正常显示错误（虽然不够友好）
- 所有新字段（`userMessage`、`suggestions`）都是**新增**的，不会破坏现有逻辑
- HTTP API 的 JSON 格式变化不影响成功响应

### 渐进式升级建议

1. **第一阶段**：更新 WebSocket ERROR 事件处理器，使用 `userMessage`
2. **第二阶段**：显示错误建议（`suggestions`）
3. **第三阶段**：根据 `severity` 区分错误严重程度
4. **第四阶段**：根据 `code` 实现特殊处理逻辑

---

## 常见问题 FAQ

### Q1: 前端必须立即升级吗？

**A**: 不是必须的。新的错误格式是向后兼容的，旧代码仍然可以工作。但建议尽快升级以提供更好的用户体验。

---

### Q2: 如何处理错误后的状态同步？

**A**: 后端已经自动处理。每次错误后，后端会主动广播最新的 `systemStatus`，前端只需正常处理 `systemStatus` 事件即可。

---

### Q3: 是否所有错误都会返回建议？

**A**: 不是。`suggestions` 数组可能为空。前端应检查 `suggestions.length > 0` 后再显示。

---

### Q4: HTTP 状态码与错误代码的关系？

**A**: HTTP 状态码表示请求的大类（4xx 客户端错误，5xx 服务器错误），错误代码（`code`）提供更具体的错误类型。前端应优先使用错误代码进行逻辑判断。

---

## 联系与支持

如有问题或需要帮助，请：

1. 查看完整的错误代码定义：`packages/server/src/utils/errors/RadioError.ts`
2. 参考架构文档：`docs/architecture-refactor-design.md`
3. 联系后端开发团队

---

**文档版本**: 1.1
**最后更新**: 2025-11-03
**相关版本**: Day14 服务层完善

**更新记录**:
- v1.1 (2025-11-03): 新增"HTTP API 路由详细说明"章节，包含9个API模块的详细错误处理文档
- v1.0 (2025-11-02): 初始版本，WebSocket和HTTP API错误格式变更说明
