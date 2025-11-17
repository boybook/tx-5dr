# 快速开始：GitHub Actions 自动发布配置

## 🚀 5 分钟快速配置

### 第 1 步：导出证书 (2 分钟)

```bash
# 在终端运行
security find-identity -v -p codesigning

# 找到 "Developer ID Application: JUNXUAN BAO" 对应的证书哈希
# 导出证书（会提示输入导出密码，例如：password123）
security export -k ~/Library/Keychains/login.keychain-db \
    -t identities \
    -f pkcs12 \
    -o ~/Desktop/certificate.p12 \
    -P "password123"

# 转换为 Base64（自动复制到剪贴板）
base64 -i ~/Desktop/certificate.p12 | pbcopy

# 删除临时文件
rm ~/Desktop/certificate.p12
```

### 第 2 步：创建应用专用密码 (1 分钟)

1. 访问 https://appleid.apple.com
2. 登录 `Junxuan.Bao@gmail.com`
3. 安全设置 → 应用专用密码 → 生成密码
4. 输入标签：`GitHub Actions`
5. 复制密码（格式：`xxxx-xxxx-xxxx-xxxx`）

### 第 3 步：配置 GitHub Secrets (2 分钟)

访问: https://github.com/boybook/tx-5dr/settings/secrets/actions

点击 "New repository secret"，依次添加：

| Name | Value | 说明 |
|------|-------|------|
| `APPLE_CERTIFICATE_BASE64` | 粘贴剪贴板内容 | 证书 Base64 编码 |
| `APPLE_CERTIFICATE_PASSWORD` | `password123` | 证书导出密码 |
| `KEYCHAIN_PASSWORD` | `github-actions-2024` | 任意强密码 |
| `APPLE_ID` | `Junxuan.Bao@gmail.com` | Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | `xxxx-xxxx-xxxx-xxxx` | 应用专用密码 |
| `APPLE_TEAM_ID` | `85SV63Z4H5` | 团队 ID |

### 第 4 步：启用 Actions 写权限 (30 秒)

1. 访问: https://github.com/boybook/tx-5dr/settings/actions
2. Workflow permissions → 选择 "Read and write permissions"
3. 点击 Save

### 第 5 步：触发构建 (1 分钟)

```bash
# 推送代码到 main 分支
git add .
git commit -m "chore: enable auto release"
git push origin main
```

### 第 6 步：查看构建状态

访问: https://github.com/boybook/tx-5dr/actions

等待 15-30 分钟（包含公证时间）

---

## ✅ 完成！

构建成功后：

1. **Nightly 版本**: https://github.com/boybook/tx-5dr/releases/tag/nightly
2. **下载文件**:
   - `TX-5DR-1.0.0-mac-arm64.dmg` (macOS Apple Silicon)
   - `TX-5DR-1.0.0-linux-x64.deb/rpm/AppImage` (Linux x64)
   - `TX-5DR-1.0.0-linux-arm64.deb/rpm/AppImage` (Linux ARM64)

---

## 🎯 发布稳定版

```bash
# 创建版本 tag
git tag v1.0.0
git push origin v1.0.0

# 访问
# https://github.com/boybook/tx-5dr/releases/tag/v1.0.0
```

---

## 📖 详细文档

查看完整配置指南：[docs/GITHUB_RELEASE_SETUP.md](./GITHUB_RELEASE_SETUP.md)
