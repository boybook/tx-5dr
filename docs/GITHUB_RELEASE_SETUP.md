# GitHub Actions 自动签名、公证和发布配置指南

本指南介绍如何配置 GitHub Actions 实现 macOS 应用的自动签名、公证和发布。

## 📋 目录

1. [准备工作](#准备工作)
2. [导出证书](#导出证书)
3. [配置 GitHub Secrets](#配置-github-secrets)
4. [触发构建](#触发构建)
5. [发布类型](#发布类型)
6. [常见问题](#常见问题)

---

## 准备工作

### 1. 所需证书

你已经拥有：
- ✅ Developer ID Application 证书（用于签名 .app）
- ✅ Developer ID Installer 证书（用于签名 .pkg）
- ✅ Team ID: `85SV63Z4H5`

### 2. 创建应用专用密码

1. 访问 https://appleid.apple.com
2. 登录你的 Apple ID: `Junxuan.Bao@gmail.com`
3. 在"登录与安全"部分，找到"应用专用密码"
4. 点击"生成密码"
5. 输入标签（如：`GitHub Actions Notarization`）
6. 复制生成的密码（格式：`xxxx-xxxx-xxxx-xxxx`）

⚠️ **重要**: 这个密码只会显示一次，请妥善保存！

---

## 导出证书

### 方法 1: 使用钥匙串访问（推荐）

1. **打开钥匙串访问** (`/Applications/Utilities/Keychain Access.app`)

2. **找到证书**
   - 在左侧选择"我的证书"
   - 找到 `Developer ID Application: JUNXUAN BAO (85SV63Z4H5)`

3. **导出证书**
   - 右键点击证书 → 导出
   - 文件格式选择：**个人信息交换 (.p12)**
   - 保存位置：桌面，文件名：`certificate.p12`
   - 设置导出密码（例如：`your-strong-password`）
   - 输入你的 macOS 用户密码以允许导出

4. **转换为 Base64**
   ```bash
   # 在终端中运行
   base64 -i ~/Desktop/certificate.p12 | pbcopy
   ```

   这会将证书的 Base64 编码复制到剪贴板。

5. **安全处理**
   - 导出完成后，**立即删除** `certificate.p12` 文件
   - Base64 字符串将用于 GitHub Secrets

### 方法 2: 使用命令行

```bash
# 1. 导出证书
security find-identity -v -p codesigning

# 2. 导出为 .p12（替换 IDENTITY_HASH 为实际的证书哈希）
security export -k ~/Library/Keychains/login.keychain-db \
    -t identities \
    -f pkcs12 \
    -o ~/Desktop/certificate.p12 \
    -P "your-export-password"

# 3. 转换为 Base64
base64 -i ~/Desktop/certificate.p12 | pbcopy

# 4. 删除临时文件
rm ~/Desktop/certificate.p12
```

---

## 配置 GitHub Secrets

### 1. 访问 GitHub 仓库设置

1. 打开你的 GitHub 仓库: https://github.com/boybook/tx-5dr
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**

### 2. 添加所需的 Secrets

依次添加以下 secrets：

#### Secret 1: `APPLE_CERTIFICATE_BASE64`
- **Name**: `APPLE_CERTIFICATE_BASE64`
- **Value**: 粘贴证书的 Base64 编码（从剪贴板粘贴）
- 点击 **Add secret**

#### Secret 2: `APPLE_CERTIFICATE_PASSWORD`
- **Name**: `APPLE_CERTIFICATE_PASSWORD`
- **Value**: 导出证书时设置的密码
- 点击 **Add secret**

#### Secret 3: `KEYCHAIN_PASSWORD`
- **Name**: `KEYCHAIN_PASSWORD`
- **Value**: 任意强密码（例如：`github-actions-keychain-2024`）
- 说明：用于在 CI 中创建临时 keychain
- 点击 **Add secret**

#### Secret 4: `APPLE_ID`
- **Name**: `APPLE_ID`
- **Value**: `Junxuan.Bao@gmail.com`
- 点击 **Add secret**

#### Secret 5: `APPLE_APP_SPECIFIC_PASSWORD`
- **Name**: `APPLE_APP_SPECIFIC_PASSWORD`
- **Value**: 应用专用密码（格式：`xxxx-xxxx-xxxx-xxxx`）
- 点击 **Add secret**

#### Secret 6: `APPLE_TEAM_ID`
- **Name**: `APPLE_TEAM_ID`
- **Value**: `85SV63Z4H5`
- 点击 **Add secret**

### 3. 验证配置

添加完成后，你应该看到 6 个 secrets：

- ✅ `APPLE_CERTIFICATE_BASE64`
- ✅ `APPLE_CERTIFICATE_PASSWORD`
- ✅ `KEYCHAIN_PASSWORD`
- ✅ `APPLE_ID`
- ✅ `APPLE_APP_SPECIFIC_PASSWORD`
- ✅ `APPLE_TEAM_ID`

---

## 触发构建

### 1. Nightly 构建（自动）

每次推送到 `main` 分支时自动触发：

```bash
git add .
git commit -m "feat: add new feature"
git push origin main
```

构建完成后会自动：
- 创建/更新 `nightly` tag
- 发布到 GitHub Releases
- 文件名格式：`TX-5DR-1.0.0-mac-arm64.dmg`

### 2. 稳定版发布（手动）

创建版本 tag：

```bash
# 1. 更新版本号（可选）
# 编辑 package.json，修改 "version": "1.0.0" 为新版本

# 2. 提交更改
git add .
git commit -m "chore: release v1.0.0"

# 3. 创建 tag
git tag v1.0.0

# 4. 推送 tag
git push origin v1.0.0
```

### 3. PR 构建（测试）

创建 Pull Request 时会触发构建，但**不会进行公证**（节省时间）。

---

## 发布类型

### Nightly Release

- **触发条件**: 推送到 `main` 分支
- **Tag**: `nightly` (自动覆盖)
- **类型**: Prerelease
- **特点**:
  - 每次推送自动构建
  - 覆盖之前的 nightly 版本
  - 包含最新的开发功能
  - 可能不稳定

### Stable Release

- **触发条件**: 推送版本 tag (如 `v1.0.0`)
- **Tag**: 对应的版本号
- **类型**: Release
- **特点**:
  - 手动触发
  - 正式发布版本
  - 经过充分测试
  - 推荐用户下载

---

## 构建产物

### macOS (Apple Silicon)

- **ARM64**: `TX-5DR-1.0.0-mac-arm64.dmg`
- **特性**:
  - ✅ 代码签名
  - ✅ 公证
  - ✅ 附加公证票据
  - ✅ DMG 磁盘镜像

### Linux

- **x64**:
  - `TX-5DR-1.0.0-linux-x64.deb`
  - `TX-5DR-1.0.0-linux-x64.rpm`
  - `TX-5DR-1.0.0-linux-x64.AppImage`

- **ARM64**:
  - `TX-5DR-1.0.0-linux-arm64.deb`
  - `TX-5DR-1.0.0-linux-arm64.rpm`
  - `TX-5DR-1.0.0-linux-arm64.AppImage`

---

## 本地测试

### 测试构建（不公证）

```bash
# macOS
yarn dist:mac

# Windows
yarn dist:win

# Linux
yarn dist:linux

# 所有平台
yarn dist:all
```

### 测试签名和公证

```bash
# 设置环境变量
export APPLE_ID="Junxuan.Bao@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="85SV63Z4H5"

# 构建并公证
yarn dist:mac
```

---

## 查看构建状态

### GitHub Actions 页面

1. 访问: https://github.com/boybook/tx-5dr/actions
2. 查看最近的 workflow 运行
3. 点击具体的运行查看详细日志

### 查看公证日志

如果公证失败，可以在 Actions 日志中查看详细错误信息。

---

## 常见问题

### Q1: 公证失败，提示 "Invalid credentials"

**解决方案**:
1. 检查 `APPLE_ID` 是否正确
2. 检查 `APPLE_APP_SPECIFIC_PASSWORD` 是否有效
3. 重新生成应用专用密码
4. 更新 GitHub Secrets

### Q2: 签名失败，提示 "No identity found"

**解决方案**:
1. 检查 `APPLE_CERTIFICATE_BASE64` 是否完整
2. 检查 `APPLE_CERTIFICATE_PASSWORD` 是否正确
3. 重新导出证书
4. 确保证书包含私钥

### Q3: 构建成功但没有创建 Release

**解决方案**:
1. 检查是否推送到了 `main` 分支
2. 检查 workflow 文件中的分支名称
3. 查看 Actions 日志中的错误信息

### Q4: Nightly release 没有自动覆盖

**解决方案**:
1. 检查 `GITHUB_TOKEN` 权限
2. 在仓库设置中启用 Actions 的写权限:
   - Settings → Actions → General
   - Workflow permissions → Read and write permissions

### Q5: 公证需要很长时间

这是正常的。Apple 公证通常需要 5-15 分钟，有时更久。请耐心等待。

### Q6: 如何跳过公证（测试用）

编辑 `electron-builder.json`:
```json
{
  "mac": {
    "notarize": false
  }
}
```

或设置环境变量：
```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false
```

---

## 安全建议

### 证书管理

- ✅ 定期更换证书导出密码
- ✅ 证书文件导出后立即删除
- ✅ 不要将证书提交到 Git 仓库
- ✅ 使用强密码保护证书

### Secrets 管理

- ✅ 定期更换应用专用密码
- ✅ 限制仓库协作者权限
- ✅ 启用 GitHub 2FA
- ✅ 审计 Secrets 的使用记录

### 监控

- ✅ 定期检查 Actions 日志
- ✅ 监控 Apple 开发者账号的活动
- ✅ 关注 GitHub Security Alerts

---

## 证书续期

Developer ID 证书有效期为 5 年。证书到期前：

1. **30 天前**: Apple 会发送提醒邮件
2. **续期**: 访问 https://developer.apple.com/account/resources/certificates
3. **更新**:
   - 撤销旧证书
   - 创建新证书
   - 重新导出并更新 GitHub Secrets

---

## 参考资源

- [Electron Builder 文档](https://www.electron.build/)
- [Apple 公证文档](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [electron-notarize](https://github.com/electron/notarize)

---

## 当前配置总结

### 已完成 ✅

- ✅ 安装 electron-builder
- ✅ 创建 electron-builder 配置文件
- ✅ 创建公证脚本 (`scripts/notarize.js`)
- ✅ 配置 entitlements.plist
- ✅ 创建 GitHub Actions workflow
- ✅ 配置 package.json 脚本

### 待配置 ⏳

- ⏳ 配置 GitHub Secrets（需要手动操作）
- ⏳ 推送代码触发首次构建
- ⏳ 验证签名和公证流程

### 下一步

1. 按照本指南配置 GitHub Secrets
2. 推送代码到 `main` 分支
3. 查看 GitHub Actions 构建日志
4. 验证 nightly release 是否成功创建

---

**配置完成后，每次推送到 `main` 分支都会自动构建、签名、公证并发布到 GitHub Releases！** 🎉
