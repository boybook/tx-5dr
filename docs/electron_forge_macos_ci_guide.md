# Electron Forge 在 macOS 上的打包、签名、公证与 DMG 制作指南

本文介绍如何使用 **Electron Forge**（不依赖 electron-builder）完成 macOS 应用的 **打包、签名、公证与 DMG 制作** 全流程，并包含 **GitHub Actions CI 自动化流程** 的配置示例。

---

## 一、概述

Electron Forge 内置了 `@electron/packager`、`@electron/osx-sign`、`@electron/notarize` 等模块，可以完成 macOS 应用的签名和公证。配合 `@electron-forge/maker-dmg` 插件，可生成可直接发布的 `.app` 与 `.dmg` 文件。

### 工作流程概览

1. 使用 Electron Forge 打包项目；
2. 使用 Developer ID 证书签名 `.app`；
3. 通过 Apple Notary Service 公证应用；
4. 自动执行 staple（钉订）操作；
5. 生成包含已公证应用的 `.dmg` 安装包。

---

## 二、项目准备

安装依赖：

```bash
npm install --save-dev electron @electron-forge/cli @electron-forge/maker-dmg
npx electron-forge import
```

如果未自动安装 DMG maker：

```bash
npm install --save-dev @electron-forge/maker-dmg
```

---

## 三、Forge 配置文件（`forge.config.js`）

```js
// forge.config.js
/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    osxSign: {
      identity: 'Developer ID Application: Your Company (TEAMID1234)',
      hardenedRuntime: true,
      entitlements: 'build/entitlements.plist',
      'entitlements-inherit': 'build/entitlements.plist',
    },
    osxNotarize: {
      tool: 'notarytool',
      appleApiKey: 'build/AuthKey_ABC123DEF.p8',
      appleApiKeyId: 'ABC123DEF',
      appleApiIssuer: '00000000-1111-2222-3333-444444444444',
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        background: './assets/dmg-background.png',
        format: 'ULFO',
        overwrite: true,
      },
    },
    { name: '@electron-forge/maker-zip' },
  ],
};
```

### 必需文件

- ``：声明应用权限与 Hardened Runtime。
- ``：Apple API Key 文件（在 CI 中动态生成）。

---

## 四、Entitlements 示例

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key><false/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

---

## 五、脚本命令

在 `package.json` 中添加：

```json
"scripts": {
  "start": "electron-forge start",
  "package:mac": "electron-forge package --platform=darwin --arch=arm64",
  "make:mac": "electron-forge make --platform=darwin --arch=arm64"
}
```

本地构建：

```bash
npm run make:mac
```

---

## 六、GitHub Actions CI 自动化

以下工作流将实现自动构建、签名、公证与上传 DMG：

```yaml
name: macOS 构建与公证

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: macos-latest

    steps:
      - name: 检出代码
        uses: actions/checkout@v4

      - name: 设置 Node.js 环境
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: 安装依赖
        run: npm ci

      - name: 生成 Apple API Key 文件
        env:
          APPLE_API_KEY_BASE64: ${{ secrets.APPLE_API_KEY_BASE64 }}
        run: |
          mkdir -p build
          echo "$APPLE_API_KEY_BASE64" | base64 --decode > build/AuthKey_ABC123DEF.p8

      - name: 打包并公证
        env:
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
        run: npm run make:mac

      - name: 上传 DMG 构建结果
        uses: actions/upload-artifact@v4
        with:
          name: macos-build
          path: out/make/**/*.dmg
```

### 必需的 GitHub Secrets

| 名称                     | 含义                  |
| ---------------------- | ------------------- |
| `APPLE_API_KEY_BASE64` | `.p8` 文件的 Base64 内容 |
| `APPLE_API_KEY_ID`     | Apple API Key ID    |
| `APPLE_API_ISSUER`     | Apple Issuer ID     |

---

## 七、常见问题与提示

### 1. 证书匹配

运行以下命令验证签名证书：

```bash
security find-identity -p codesigning -v
```

确保 `identity` 与证书名称完全一致（如 `Developer ID Application: Your Company (TEAMID1234)`）。

### 2. 公证失败

- 确认 `.p8` 密钥在 App Store Connect 中权限正确；
- 检查 entitlements 路径是否有效并启用了 Hardened Runtime。

### 3. DMG 被 Gatekeeper 拦截

macOS 审查 `.app` 而非 `.dmg`，确保 `.app` 已成功公证并 staple。

### 4. 手动测试公证

```bash
xcrun notarytool submit path/to/MyApp.zip --apple-id user@apple.com --team-id TEAMID1234 --password app-specific-password
```

---

## 八、总结

通过该配置，Electron Forge 可独立完成：

✅ 打包 → ✅ 签名 → ✅ 公证 → ✅ DMG 生成

无需依赖 electron-builder，支持本地与 GitHub Actions 自动化构建。

---

© 2025 EaseCation Labs — macOS 应用发布流程模板

