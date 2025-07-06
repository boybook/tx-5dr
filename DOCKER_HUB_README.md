# Docker Hub README 更新指南

这个指南将帮助你设置和使用Docker Hub README自动更新功能。

## 🔑 设置Docker Hub访问令牌

1. **登录Docker Hub**
   - 访问 https://hub.docker.com 并登录你的账户

2. **创建访问令牌**
   - 点击用户头像 → Account Settings
   - 选择 "Security" 标签
   - 点击 "New Access Token"
   - 输入令牌名称（如：`tx-5dr-readme-update`）
   - 选择权限：**Repository: Read, Write**
   - 点击 "Generate" 生成令牌
   - **重要**：立即复制令牌，这是唯一查看的机会

3. **设置环境变量**
   ```bash
   # 临时设置（当前会话）
   export DOCKER_HUB_TOKEN='your-token-here'
   
   # 永久设置（添加到 ~/.bashrc 或 ~/.zshrc）
   echo 'export DOCKER_HUB_TOKEN="your-token-here"' >> ~/.zshrc
   source ~/.zshrc
   ```

## 📝 使用方法

### 1. 只更新README（推荐用于测试）

```bash
# 只更新README，不构建镜像
./scripts/build-docker.sh --readme-only boybook tx-5dr
```

### 2. 构建并推送，同时更新README

```bash
# 构建、推送并更新README（默认行为）
./scripts/build-docker.sh boybook tx-5dr latest true
```

### 3. 构建但不更新README

```bash
# 构建但跳过README更新
./scripts/build-docker.sh --no-readme boybook tx-5dr latest true
```

### 4. 查看帮助信息

```bash
./scripts/build-docker.sh --help
```

## 🔧 环境变量

| 变量 | 描述 | 必需 |
|------|------|------|
| `DOCKER_HUB_TOKEN` | Docker Hub访问令牌 | 是 |
| `DOCKER_HUB_USERNAME` | Docker Hub用户名（如果与registry不同） | 否 |

## 📋 README文件位置

脚本会自动读取 `docker/README.md` 文件作为Docker Hub的README内容。

## 🚀 集成到CI/CD

在GitHub Actions中使用：

```yaml
# .github/workflows/docker.yml
- name: Build and push Docker image
  env:
    DOCKER_HUB_TOKEN: ${{ secrets.DOCKER_HUB_TOKEN }}
  run: |
    ./scripts/build-docker.sh boybook tx-5dr latest true
```

记得在GitHub仓库设置中添加 `DOCKER_HUB_TOKEN` 密钥：
- 仓库 → Settings → Secrets and variables → Actions
- 点击 "New repository secret"
- 名称：`DOCKER_HUB_TOKEN`
- 值：你的Docker Hub访问令牌

## 🔍 故障排除

### 常见问题

1. **401 Unauthorized**
   - 检查令牌是否正确设置
   - 确认令牌有写入权限

2. **404 Not Found**
   - 检查仓库名称是否正确
   - 确认仓库在Docker Hub上存在

3. **jq: command not found**
   ```bash
   # macOS
   brew install jq
   
   # Ubuntu/Debian
   sudo apt-get install jq
   ```

### 调试模式

可以通过设置环境变量来开启调试：

```bash
export DEBUG=1
./scripts/build-docker.sh --readme-only boybook tx-5dr
```

## 📊 脚本功能

- ✅ 自动读取 `docker/README.md`
- ✅ 验证Docker Hub令牌
- ✅ 支持多种运行模式
- ✅ 详细的错误信息
- ✅ 集成到构建流程
- ✅ 支持自定义用户名
- ✅ 跨平台兼容性

## 🎯 最佳实践

1. **测试先行**：首先使用 `--readme-only` 模式测试
2. **安全令牌**：不要在代码中硬编码令牌
3. **权限最小化**：只给令牌必要的权限
4. **定期更新**：定期更新Docker Hub令牌
5. **监控日志**：检查构建日志确认README更新成功

## 📚 参考资料

- [Docker Hub API文档](https://docs.docker.com/docker-hub/api/latest/)
- [Docker Hub访问令牌](https://docs.docker.com/docker-hub/access-tokens/)
- [GitHub Actions密钥](https://docs.github.com/en/actions/security-guides/encrypted-secrets) 