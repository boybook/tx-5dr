# macOS 打包签名公证规范化 - 变更总结

## ✅ 完成的改动

### 1. 安装依赖
- ✅ 添加 `@electron-forge/maker-dmg@^7.10.2`

### 2. 新增文件
- ✅ `build/entitlements.mac.plist` - macOS 权限配置文件
- ✅ `docs/macos_signing_guide.md` - 完整使用指南

### 3. 配置更新

#### `forge.config.js`
- ✅ 更新 `osxSign` 配置:
  - CI 环境: 使用 `APPLE_TEAM_ID` 环境变量指定证书
  - 本地环境: 自动从钥匙串查找证书,支持 `CSC_IDENTITY_AUTO_DISCOVERY=false` 禁用
- ✅ 更新 `osxNotarize` 配置:
  - CI 环境: 使用 `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` 进行公证
  - 本地环境: 默认不公证
- ✅ 添加 DMG maker (同时保留 ZIP maker)
- ✅ 添加深度签名 hook:
  - 自动扫描 `node_modules` 中所有 `.node` 和 `.dylib` 文件
  - 递归签名所有原生模块 (naudiodon2, wsjtx-lib, hamlib, serialport 等)

#### `package.json`
- ✅ 规范化命令:
  - 新增: `package:mac`, `package:mac:x64` - 仅打包不制作安装包
  - 新增: `make:mac`, `make:mac:x64` - 完整打包并制作安装包
  - 新增: `make:mac:unsigned` - 开发测试用无签名构建
  - 简化: `build:make` - 移除 `generate-ico.js` (仅 Windows 需要)
  - 移除: `fresh-build` - 不常用命令

#### `.github/workflows/build-release.yml`
- ✅ 添加 macOS 证书导入步骤 (在构建前)
- ✅ 添加签名和公证环境变量:
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`
- ✅ 更新 macOS artifact 上传配置 (支持 DMG + ZIP)

---

## 📦 产物变化

### 之前
```
out/make/zip/darwin/arm64/
└── TX-5DR-darwin-arm64-1.0.0.zip (未签名/未公证)
```

### 现在

**本地开发:**
```
out/make/
├── dmg/darwin/arm64/
│   └── TX-5DR-1.0.0-arm64.dmg (已签名/未公证)
└── zip/darwin/arm64/
    └── TX-5DR-darwin-arm64-1.0.0.zip (已签名/未公证)
```

**GitHub Actions CI:**
```
out/make/
├── dmg/darwin/arm64/
│   └── TX-5DR-1.0.0-arm64.dmg (已签名/已公证/已staple)
└── zip/darwin/arm64/
    └── TX-5DR-darwin-arm64-1.0.0.zip (已签名/已公证)
```

---

## 🔑 GitHub Secrets 配置要求

确保以下 secrets 已在 GitHub 仓库设置中配置:

| Secret 名称 | 说明 |
|------------|------|
| `APPLE_CERTIFICATE_BASE64` | Developer ID Application 证书 (p12 base64) |
| `APPLE_CERTIFICATE_PASSWORD` | 证书密码 |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_TEAM_ID` | 团队 ID (例如: `ABCD123456`) |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码 |

详见 `docs/macos_signing_guide.md` 中的配置说明。

---

## 🚀 使用方法

### 本地开发

```bash
# 开发测试 (快速,不签名)
yarn make:mac:unsigned

# 签名构建 (需要已安装证书)
yarn make:mac

# 仅打包 (不制作 DMG/ZIP)
yarn package:mac

# Intel Mac 构建
yarn make:mac:x64
```

### GitHub Actions

推送代码到 `main` 或 `develop` 分支,或创建 PR,会自动触发构建。

macOS 构建会自动:
1. 导入证书
2. 签名主应用
3. 深度签名所有原生模块
4. 提交公证
5. 等待公证完成
6. Staple 公证凭证
7. 生成 DMG 和 ZIP
8. 上传到 GitHub Artifacts

---

## ✅ 验证步骤

### 1. 本地测试无签名构建
```bash
yarn make:mac:unsigned
```
应该成功生成 DMG 和 ZIP 文件。

### 2. 本地测试签名构建 (如果有证书)
```bash
yarn make:mac
```
验证签名:
```bash
codesign -dv --verbose=4 out/TX-5DR-darwin-arm64/TX-5DR.app
```

### 3. GitHub Actions 测试
推送代码触发 CI,检查:
- ✅ 证书导入成功
- ✅ 深度签名完成 (查看日志中的签名列表)
- ✅ 公证提交成功
- ✅ DMG 和 ZIP 都上传到 Artifacts

### 4. 下载 CI 产物验证
从 GitHub Actions 下载 artifact,验证:
```bash
# 检查签名
codesign -dv --verbose=4 TX-5DR.app

# 检查公证
spctl -a -vv TX-5DR.app

# 应该显示: source=Notarized Developer ID
```

---

## 📚 相关文档

- `docs/macos_signing_guide.md` - 完整使用指南
- `docs/electron_forge_macos_ci_guide.md` - 原始参考文档
- `forge.config.js` - Electron Forge 配置
- `build/entitlements.mac.plist` - macOS 权限配置

---

## 🐛 已知问题及修复

### ~~1. GitHub Actions 签名失败 - adhoc 签名 (已修复)~~

**问题 1: 初次尝试 - Identity 字符串不完整**
```
TX-5DR.app: code has no resources but signature indicates they must be present
Info.plist=not bound
TeamIdentifier=not set
Signature=adhoc
```

**原因:**
`forge.config.js` 中的 `osxSign.identity` 配置只提供了 `APPLE_TEAM_ID` 而没有完整的证书名称。

**修复 (第一次):**
移除手动构造的 identity,改为自动查找。

**问题 2: adhoc 签名问题**
修复后依然显示 `Signature=adhoc`,说明 `@electron/osx-sign` 没有找到证书,而是降级使用了临时签名。

**根本原因:**
虽然证书已通过 `security import` 导入到钥匙串,但自动查找机制失败。

**最终修复:**
在打包步骤中,通过 shell 脚本在同一个会话中提取证书 identity 并设置环境变量:

```yaml
# GitHub Actions: 在打包步骤中提取并使用证书
- name: Package application
  shell: bash
  env:
    NODE_ENV: production
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  run: |
    # macOS: 解锁钥匙串并提取证书 identity
    if [ "${{ matrix.os }}" = "macos-latest" ]; then
      echo "🔓 解锁钥匙串并提取证书..."
      security unlock-keychain -p actions temp.keychain

      CERT_IDENTITY=$(security find-identity -v -p codesigning temp.keychain | grep "Developer ID Application" | head -1 | grep -o '"[^"]*"' | tr -d '"')
      echo "✅ 使用证书: $CERT_IDENTITY"

      export APPLE_IDENTITY="$CERT_IDENTITY"  # 在当前 shell 中导出
    fi

    # 执行打包
    yarn ${{ matrix.build_command }}
```

```javascript
// forge.config.js: 使用显式的 identity
osxSign: (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' ? false : {
  identity: process.env.APPLE_IDENTITY || undefined,  // CI 使用显式 identity,本地自动查找
  hardenedRuntime: true,
  entitlements: 'build/entitlements.mac.plist',
  'entitlements-inherit': 'build/entitlements.mac.plist',
  'signature-flags': 'library'
})
```

**关键改进:**
- 在同一个 shell 会话中设置 `APPLE_IDENTITY` 并执行 `yarn make`
- 避免了 GitHub Actions 环境变量传递的时序问题
- 更简洁,减少步骤数

### 2. EMFILE 错误 - 文件描述符耗尽 (已修复)

**问题:**
```
spawn codesign EMFILE
Error: spawn codesign EMFILE
✖ Finalizing package [FAILED: Cannot read properties of undefined (reading 'on')]
```

**根本原因:**
1. `electron-osx-sign` v1.3.3 在遍历包含大量原生模块的应用时,会并发打开过多文件
2. GitHub Actions macOS runner 的默认文件描述符限制较低（ulimit -n 通常为 256）
3. 项目包含多个原生模块（naudiodon2, wsjtx-lib, hamlib, serialport 等），每个都有多个 `.node` 和 `.dylib` 文件
4. 在 "Walking..." 阶段超出了系统限制

**最终修复:**
在 GitHub Actions 的打包步骤中增加文件描述符限制:

```yaml
# .github/workflows/build-release.yml
- name: Package application
  run: |
    # macOS: 增加文件描述符限制,避免 EMFILE 错误
    if [ "${{ matrix.os }}" = "macos-latest" ]; then
      echo "🔧 增加文件描述符限制..."
      ulimit -n 10240
      echo "✅ 文件描述符限制已设置为: $(ulimit -n)"
    fi

    # ... 其余打包代码
```

**关键改进:**
- 将 macOS runner 的文件描述符限制从 256 提升到 10240
- 允许 electron-osx-sign 同时处理更多文件
- 解决了签名大型应用时的 EMFILE 错误

**后续建议:**
- 考虑升级 `@electron-forge` 到 v7.12.x 以使用更新的 `@electron/osx-sign` v2.x（包含 EMFILE 修复）
- v2.x 版本通过序列化文件遍历从根本上避免了此问题

### 3. adhoc 签名 + "code has no resources" 错误 (已修复)

**问题:**
```
TX-5DR.app: code has no resources but signature indicates they must be present
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
```

**根本原因:**
1. **Electron Forge 的生命周期顺序**: `packageAfterCopy` → **签名 (osxSign)** → `postPackage`
2. 原先的 `postPackage` hook 在签名**之后**删除了大量文件（精简 node_modules、清理跨平台二进制）
3. 这些文件修改破坏了已完成的签名,导致签名验证失败
4. macOS 检测到应用结构被修改,降级为 adhoc 签名

**最终修复:**
将所有文件清理操作从 `postPackage` 移到 `packageAfterCopy` hook:

```javascript
// forge.config.js
hooks: {
  // 在签名前清理文件（新增）
  packageAfterCopy: async (forgeConfig, buildPath, electronVersion, platform, arch) => {
    // 精简 node_modules
    // 清理跨平台二进制
    // 所有文件修改操作在签名前完成
  },

  // 在签名后仅签名外部 Node 二进制（修改）
  postPackage: async (forgeConfig, options) => {
    // 仅保留签名外部 Node 二进制的逻辑
    // 不再进行文件删除操作
  }
}
```

**关键改进:**
- 文件清理在签名前完成,确保签名的应用结构不再被修改
- `postPackage` 仅用于签名 `extraResource` 中的外部 Node 二进制
- 签名验证成功,TeamIdentifier 正确设置

### 4. 其他注意事项

1. **eslint 配置缺失**: 部分包的 eslint 配置缺失,但不影响打包流程
2. **首次 CI 构建**: 首次运行 CI 时需要确保所有 secrets 正确配置

---

## 🎯 后续优化建议

1. **自动版本号**: 考虑从 git tag 自动读取版本号
2. **DMG 背景图**: 可添加自定义 DMG 背景图 (`packages/electron-main/assets/dmg-background.png`)
3. **icns 图标**: 考虑生成 macOS .icns 格式图标以获得更好的显示效果
4. **通用二进制**: 考虑构建 universal (x64+arm64) 二进制

---

© 2025 TX-5DR Team
