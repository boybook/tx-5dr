# macOS 签名与公证完整指南

本文档说明 TX-5DR 项目在 macOS 平台上的代码签名、公证和 DMG 制作的完整流程。

## 📋 目录

- [配置文件说明](#配置文件说明)
- [本地开发使用](#本地开发使用)
- [GitHub Actions CI](#github-actions-ci)
- [故障排查](#故障排查)
- [验证签名和公证](#验证签名和公证)

---

## 配置文件说明

### 1. `build/entitlements.mac.plist`

定义应用的权限和 Hardened Runtime 配置:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- 允许 JIT 编译 (Node.js/V8 需要) -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>

  <!-- 允许未签名的可执行内存 (某些原生模块需要) -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>

  <!-- 禁用库验证 (允许加载第三方动态库) -->
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>

  <!-- 音频输入权限 (naudiodon2 需要) -->
  <key>com.apple.security.device.audio-input</key>
  <true/>

  <!-- 网络客户端权限 -->
  <key>com.apple.security.network.client</key>
  <true/>
</dict>
</plist>
```

### 2. `forge.config.js`

#### 签名配置 (`osxSign`)

```javascript
osxSign: (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' ? false : {
  // 使用显式的 identity (CI 从证书提取) 或自动查找 (本地)
  identity: process.env.APPLE_IDENTITY || undefined,
  hardenedRuntime: true,
  entitlements: 'build/entitlements.mac.plist',
  'entitlements-inherit': 'build/entitlements.mac.plist',
  'signature-flags': 'library'
})
```

**工作原理:**
- **CI 环境**:
  - GitHub Actions 导入证书后,从钥匙串提取完整的 identity 字符串
  - 通过 `APPLE_IDENTITY` 环境变量传递给 Electron Forge
  - 例如: `"Developer ID Application: Your Name (TEAM_ID)"`
- **本地环境**:
  - 当 `APPLE_IDENTITY` 未设置时,`@electron/osx-sign` 自动从钥匙串查找
  - 自动选择第一个找到的 Developer ID Application 证书
- **禁用签名**: 设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 环境变量

#### 公证配置 (`osxNotarize`)

```javascript
osxNotarize: (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ? {
  tool: 'notarytool',
  appleId: process.env.APPLE_ID,
  appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
  teamId: process.env.APPLE_TEAM_ID
} : undefined  // 本地和 CI 都可以公证
```

**工作原理:**
- **有公证凭据**: 自动进行公证（本地或 CI）
- **无公证凭据**: 跳过公证，但会输出原因（便于调试）

**环境变量要求:**
- `APPLE_ID`: Apple ID 邮箱
- `APPLE_APP_SPECIFIC_PASSWORD`: App 专用密码
- `APPLE_TEAM_ID`: 团队 ID

#### 自动递归签名

`electron-osx-sign` 会在打包过程中自动递归签名所有内部文件:

- ✅ 自动签名所有 `.node` 原生模块（naudiodon2, serialport 等）
- ✅ 自动签名所有 `.dylib` 动态库（wsjtx-lib, hamlib 等）
- ✅ 使用 `hardenedRuntime` 和 `entitlements` 配置
- ✅ `signature-flags: 'library'` 确保库文件正确签名

#### 外部 Node 二进制签名

项目在 `resources/bin/darwin-{arch}/node` 包含了一个外部 Node 二进制文件（用于运行服务端代码）。

**重要**：`electron-osx-sign` 不会自动签名 `extraResource` 中的可执行文件，因此我们在 `postPackage` hook 中手动签名：

```javascript
// 签名外部 Node 二进制
if (options.platform === 'darwin' && process.env.APPLE_IDENTITY) {
  const nodeBinaryPath = path.join(resourcesDir, 'bin', triplet, 'node');
  execSync(`codesign --force --sign "${process.env.APPLE_IDENTITY}" --options runtime --entitlements "${entitlementsPath}" --timestamp "${nodeBinaryPath}"`);
}
```

这样确保应用包内的所有可执行文件都被正确签名，满足公证要求。

#### DMG + ZIP 双格式输出

```javascript
makers: [
  // macOS: DMG 安装包
  {
    name: '@electron-forge/maker-dmg',
    platforms: ['darwin'],
    config: {
      format: 'ULFO',
      overwrite: true
    }
  },
  // macOS: ZIP 便携版
  {
    name: '@electron-forge/maker-zip',
    platforms: ['darwin'],
    config: {}
  }
]
```

---

## 本地开发使用

### 前提条件

1. **安装 Developer ID Application 证书**
   - 从 Apple Developer 下载证书 (`.cer` 或 `.p12`)
   - 双击安装到"钥匙串访问"中
   - 确认证书在"登录"钥匙串的"我的证书"分类下

2. **验证证书**
   ```bash
   security find-identity -p codesigning -v
   ```
   应该显示类似:
   ```
   1) ABCD1234... "Developer ID Application: Your Name (TEAM_ID)"
   ```

### 构建命令

#### 1. 开发测试 (不签名)
```bash
yarn make:mac:unsigned
```
- 快速构建,不进行代码签名
- 适合本地开发和测试
- 输出: `out/make/zip/darwin/arm64/TX-5DR-darwin-arm64-*.zip`

#### 2. 签名构建 (本地)
```bash
yarn make:mac
```
- 自动从钥匙串查找 Developer ID Application 证书
- 进行代码签名但**不进行公证**
- 输出:
  - DMG: `out/make/dmg/darwin/arm64/TX-5DR-*.dmg`
  - ZIP: `out/make/zip/darwin/arm64/TX-5DR-darwin-arm64-*.zip`

#### 3. 仅打包 (不制作安装包)
```bash
yarn package:mac
```
- 生成 `.app` 文件但不制作 DMG/ZIP
- 输出: `out/TX-5DR-darwin-arm64/TX-5DR.app`

#### 4. x64 架构构建
```bash
yarn make:mac:x64
```
- 构建 Intel 芯片 macOS 版本

### 本地公证测试

本地可以进行完整的签名和公证流程测试:

```bash
# 1. 设置公证环境变量
export APPLE_ID="your@email.com"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
export APPLE_APP_SPECIFIC_PASSWORD="your-app-specific-password"

# 2. 执行完整构建、签名和公证
yarn make:mac

# 公证过程会自动进行:
# - 签名应用
# - 提交到 Apple 公证服务器
# - 等待公证完成（通常 2-5 分钟）
# - 自动 staple 公证凭证到 DMG
# - 生成 DMG 和 ZIP
```

**查看公证状态:**

```bash
# 检查应用是否已公证
spctl -a -vv out/TX-5DR-darwin-arm64/TX-5DR.app
# 应该显示: source=Notarized Developer ID

# 检查 DMG 是否已 staple
xcrun stapler validate out/make/dmg/darwin/arm64/TX-5DR-*.dmg
# 应该显示: The validate action worked!
```

**手动公证（如果自动公证失败）:**

```bash
# 1. 压缩 .app
cd out/TX-5DR-darwin-arm64
zip -r TX-5DR.zip TX-5DR.app

# 2. 提交公证
xcrun notarytool submit TX-5DR.zip \
  --apple-id "your@email.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "your-app-specific-password" \
  --wait

# 3. 查看公证日志
xcrun notarytool log <submission-id> \
  --apple-id "your@email.com" \
  --password "your-app-specific-password"

# 4. Staple 公证凭证
xcrun stapler staple TX-5DR.app
```

---

## GitHub Actions CI

### 所需 Secrets

在 GitHub 仓库设置中配置以下 secrets:

| Secret 名称 | 说明 | 获取方式 |
|------------|------|---------|
| `APPLE_CERTIFICATE_BASE64` | Developer ID Application 证书的 Base64 编码 | 见下方说明 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书密码 | 导出 p12 时设置的密码 |
| `APPLE_ID` | Apple ID 邮箱 | 你的 Apple Developer 账号邮箱 |
| `APPLE_TEAM_ID` | 团队 ID | 在 Apple Developer 网站查看 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码 | 在 appleid.apple.com 生成 |

#### 生成 APPLE_CERTIFICATE_BASE64

```bash
# 1. 从钥匙串导出 p12 证书
# 在"钥匙串访问"中找到证书 → 右键 → 导出 → 选择 .p12 格式 → 设置密码

# 2. 转换为 Base64
base64 -i /path/to/certificate.p12 | pbcopy

# 3. 将剪贴板内容粘贴到 GitHub Secret
```

#### 生成 App-Specific Password

1. 访问 https://appleid.apple.com
2. 登录你的 Apple ID
3. 进入"安全"部分
4. 生成"App 专用密码"
5. 复制密码并保存到 GitHub Secret

### CI 工作流程

当推送代码到 GitHub 时,工作流会自动:

1. **导入证书** - 从 base64 解码并导入到临时钥匙串
2. **构建应用** - 运行 `yarn build`
3. **修复 dylib** - 调整 wsjtx-lib 的动态库路径
4. **打包签名** - 运行 `yarn make`,electron-osx-sign 自动:
   - 签名主应用
   - 递归签名所有内部 `.node` 和 `.dylib` 文件
   - 提交公证
   - 等待公证完成
   - 自动 staple 公证凭证
   - 生成 DMG 和 ZIP
5. **上传产物** - 上传 DMG 和 ZIP 到 GitHub Artifacts

### 输出产物

```
out/make/
├── dmg/darwin/arm64/
│   └── TX-5DR-1.0.0-arm64.dmg  (已签名 + 已公证 + 已 staple)
└── zip/darwin/arm64/
    └── TX-5DR-darwin-arm64-1.0.0.zip  (已签名 + 已公证)
```

---

## 故障排查

### 1. 签名失败: "no identity found"

**症状:**
```
Error: No identity found for signing
```

**解决方法:**
- 本地: 检查证书是否正确安装在钥匙串中
- CI: 检查 `APPLE_CERTIFICATE_BASE64` 和 `APPLE_CERTIFICATE_PASSWORD` 是否正确配置

### 2. 公证失败: "Invalid Code Signature"

**症状:**
```
The signature of the binary is invalid
```

**原因:** 内部的 `.node` 或 `.dylib` 文件未签名

**解决方法:**
- 确认 `osxSign` 配置中的 `hardenedRuntime: true` 和 `signature-flags: 'library'` 已设置
- 检查 CI 日志中 electron-osx-sign 的详细输出（启用 `verbose: true`）
- 验证 `build/entitlements.mac.plist` 文件存在且配置正确

### 3. 公证失败: "Invalid Hardened Runtime"

**症状:**
```
The executable does not have the hardened runtime enabled
```

**解决方法:** 确认 `entitlements.mac.plist` 文件存在且配置正确

### 4. dylib 加载失败

**症状:**
```
dyld: Library not loaded: /opt/homebrew/opt/...
```

**原因:** 动态库路径未正确修复

**解决方法:** 检查 GitHub Actions 中的 "Patch wsjtx-lib dylib install names" 步骤是否成功

### 5. 本地无法打开 "已损坏"

**症状:** macOS 提示应用"已损坏,无法打开"

**原因:** 未签名或签名验证失败

**解决方法:**
```bash
# 临时允许运行 (仅用于测试)
xattr -cr /path/to/TX-5DR.app
```

### 6. EMFILE: 签名时文件描述符耗尽 (CI 环境)

**症状:**
```
spawn codesign EMFILE
Error: spawn codesign EMFILE
```

**原因:**
- electron-osx-sign 在遍历大量原生模块时打开太多文件
- 系统文件描述符限制过低（默认 256）

**解决方法 (GitHub Actions):**
已在工作流中自动设置 `ulimit -n 10240`

**解决方法 (本地):**
```bash
# 临时增加限制
ulimit -n 10240

# 验证
ulimit -n

# 然后执行打包
yarn make:mac
```

---

## 验证签名和公证

### 检查代码签名

```bash
# 检查主应用签名
codesign -dv --verbose=4 out/TX-5DR-darwin-arm64/TX-5DR.app

# 检查所有二进制文件的签名
find out/TX-5DR-darwin-arm64/TX-5DR.app -name "*.node" -o -name "*.dylib" | while read file; do
  echo "Checking: $file"
  codesign -dv "$file"
done
```

### 检查 Hardened Runtime

```bash
codesign -d --entitlements - out/TX-5DR-darwin-arm64/TX-5DR.app
```

### 检查公证状态

```bash
# 检查是否已公证
spctl -a -vv out/TX-5DR-darwin-arm64/TX-5DR.app

# 应该显示:
# source=Notarized Developer ID
```

### 检查 Staple 状态

```bash
xcrun stapler validate out/TX-5DR-darwin-arm64/TX-5DR.app

# 应该显示:
# The validate action worked!
```

---

## 命令速查表

| 命令 | 功能 | 签名 | 公证 |
|-----|------|------|------|
| `yarn make:mac:unsigned` | 快速构建 (无签名) | ❌ | ❌ |
| `yarn make:mac` | 本地签名构建 | ✅ | ❌ |
| `yarn package:mac` | 仅打包 .app | ✅ | ❌ |
| GitHub Actions | CI 自动构建 | ✅ | ✅ |

---

## 相关资源

- [Apple 公证指南](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Electron 签名和公证](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron Forge 配置](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [@electron/osx-sign](https://github.com/electron/osx-sign)
- [@electron/notarize](https://github.com/electron/notarize)

---

© 2025 TX-5DR Team
