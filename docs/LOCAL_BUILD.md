# 本地构建指南

## 📦 使用 electron-builder 构建

### 构建命令

```bash
# 构建当前平台
yarn dist

# 构建 macOS (DMG)
yarn dist:mac

# 构建 Windows (NSIS)
yarn dist:win

# 构建 Linux (deb, rpm, AppImage)
yarn dist:linux --x64        # 构建 x64 架构
yarn dist:linux --arm64      # 构建 ARM64 架构

# 构建所有平台
yarn dist:all
```

### 输出目录

```
out/electron-builder/
├── TX-5DR-1.0.0-mac-arm64.dmg
├── TX-5DR-1.0.0-mac-x64.dmg
├── TX-5DR-1.0.0-win-x64.exe
├── TX-5DR-1.0.0-linux-x64.deb
├── TX-5DR-1.0.0-linux-x64.rpm
└── TX-5DR-1.0.0-linux-x64.AppImage
```

---

## 🍎 macOS 签名和公证

### 方法 1: 使用自动签名（推荐）

```bash
# 设置环境变量
export APPLE_ID="Junxuan.Bao@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="85SV63Z4H5"

# 构建并自动签名+公证
yarn dist:mac
```

electron-builder 会自动：
1. ✅ 签名所有二进制文件
2. ✅ 签名主应用
3. ✅ 创建 DMG
4. ✅ 提交公证
5. ✅ 附加公证票据

### 方法 2: 跳过公证（快速测试）

```bash
# 只签名，不公证（节省时间）
CSC_IDENTITY_AUTO_DISCOVERY=false yarn dist:mac
```

注意：跳过公证的应用在其他 Mac 上可能无法直接运行。

### 验证签名和公证

```bash
# 验证签名
codesign --verify --deep --strict --verbose=2 \
    "out/electron-builder/mac-arm64/TX-5DR.app"

# 验证公证
spctl --assess --verbose=4 --type execute \
    "out/electron-builder/mac-arm64/TX-5DR.app"

# 验证 DMG
spctl --assess --verbose=4 --type open --context context:primary-signature \
    "out/electron-builder/TX-5DR-1.0.0-mac-arm64.dmg"
```

---

## 🐧 Linux 构建

### 前提条件

```bash
# Ubuntu/Debian
sudo apt-get install -y \
    libasound2-dev libpulse-dev \
    portaudio19-dev build-essential \
    rpm

# Fedora/RHEL
sudo dnf install -y \
    alsa-lib-devel pulseaudio-libs-devel \
    portaudio-devel rpm-build
```

### 构建

```bash
# 构建 x64 架构
yarn dist:linux --x64

# 构建 ARM64 架构
yarn dist:linux --arm64
```

### 输出

构建 x64：
- `TX-5DR-1.0.0-linux-x64.deb` - Debian 包
- `TX-5DR-1.0.0-linux-x64.rpm` - RPM 包
- `TX-5DR-1.0.0-linux-x64.AppImage` - AppImage

构建 ARM64：
- `TX-5DR-1.0.0-linux-arm64.deb` - Debian 包
- `TX-5DR-1.0.0-linux-arm64.rpm` - RPM 包
- `TX-5DR-1.0.0-linux-arm64.AppImage` - AppImage

---

## 🔧 配置文件

### electron-builder.json

主配置文件，定义：
- 应用 ID 和产品名称
- 打包文件和资源
- 平台特定配置
- 签名和公证设置

### scripts/entitlements.plist

macOS 权限配置：
- 硬化运行时
- JIT 编译
- 音频/蓝牙/USB 权限
- 网络权限

### scripts/notarize.js

公证脚本：
- 自动提交到 Apple 公证服务
- 处理公证失败
- 附加公证票据

---

## 🚀 构建优化

### 减小包体积

1. **清理 node_modules**
   ```bash
   yarn clean
   yarn install --production
   ```

2. **使用 asar**

   编辑 `electron-builder.json`:
   ```json
   {
     "asar": true,
     "asarUnpack": [
       "node_modules/naudiodon2/**/*"
     ]
   }
   ```

3. **排除开发依赖**

   已在配置中自动处理。

### 加快构建速度

```bash
# 只构建当前架构
yarn dist:mac --arm64

# 跳过公证（测试用）
CSC_IDENTITY_AUTO_DISCOVERY=false yarn dist:mac

# 并行构建多个平台（需要足够资源）
yarn dist:all --parallel
```

---

## 📊 构建时间参考

| 平台 | 构建时间 | 签名+公证 | 总计 |
|------|---------|----------|------|
| macOS ARM64 | ~5 分钟 | ~10 分钟 | ~15 分钟 |
| macOS x64 | ~6 分钟 | ~10 分钟 | ~16 分钟 |
| Windows x64 | ~8 分钟 | - | ~8 分钟 |
| Linux x64 | ~5 分钟 | - | ~5 分钟 |

---

## 🐛 常见问题

### Q: 构建失败，提示找不到模块

```bash
# 重新安装依赖
yarn clean
rm -rf node_modules
yarn install
```

### Q: macOS 签名失败

```bash
# 检查证书
security find-identity -v -p codesigning

# 重新导入证书
# 双击 .cer 文件或使用钥匙串访问
```

### Q: 公证超时

公证通常需要 5-15 分钟，有时更久。如果超过 30 分钟：

```bash
# 查看公证状态
xcrun notarytool history --keychain-profile "tx5dr-notarization"

# 获取详细日志
xcrun notarytool log <REQUEST_UUID> --keychain-profile "tx5dr-notarization"
```

### Q: DMG 无法打开

```bash
# 重新签名 DMG
codesign --force --sign "Developer ID Application: JUNXUAN BAO (85SV63Z4H5)" \
    "out/electron-builder/TX-5DR-1.0.0-mac-arm64.dmg"
```

---

## 📚 参考资源

- [electron-builder 文档](https://www.electron.build/)
- [Apple 代码签名指南](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/)
- [Apple 公证文档](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [docs/GITHUB_RELEASE_SETUP.md](./GITHUB_RELEASE_SETUP.md)
