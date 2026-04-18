# Rigctld 兼容桥接

TX-5DR 内置一个 Hamlib `rigctld` 协议兼容的 TCP 服务器，允许外部软件通过标准的
**NET rigctl (model 2)** 协议控制当前连接的电台——即使该电台原本是通过 ICOM
WLAN、Hamlib 串口或 Hamlib 网络连接占用的。典型用途是在比赛 / 数字模式通联中
与 **N1MM Logger+**、**WSJT-X**、**JTDX**、**fldigi** 等软件共享同一部电台。

## 启用方式

在 Web UI 打开 **System Settings → Rigctld Bridge**：

1. 打开开关。
2. 设置监听地址：
   - **127.0.0.1**：仅本机访问（N1MM 与 tx5dr 运行在同一台机器时使用）。
   - **0.0.0.0**：对整个局域网开放（N1MM 在另一台机器上时必须用这个）。
3. 保存。右侧会显示实时运行状态与已连接客户端。

默认端口 **4532**，与 Hamlib 官方 rigctld 保持一致。

## 外部软件接入

### N1MM Logger+
`Configurer → Hardware → Radio 1`

- Radio: `NET`
- Port: `127.0.0.1:4532`（同机）或 `192.168.x.x:4532`（远程）

### WSJT-X / JTDX
`Settings → Radio`

- Rig: **Hamlib NET rigctl**
- Network Server: `127.0.0.1:4532` 或 `<host>:4532`
- 建议勾选 "Poll Interval"（默认即可）

### fldigi
`Configure → Rig Control → Hamlib`

- Rig: `Hamlib NET rigctl (stub)`
- Device: `127.0.0.1:4532`

## 不同部署模式

| 模式 | 默认可达 | 操作要点 |
| --- | --- | --- |
| `yarn dev` / 桌面 Electron | ✅ 立即可用 | UI 中启用，地址按需选 `127.0.0.1` / `0.0.0.0` |
| Docker (`docker-compose up -d`) | ⚠️ 需端口映射 | 仓库的 `docker-compose.yml` 已预置 `-p 4532:4532`；UI 中必须把监听地址改成 `0.0.0.0`，否则容器外不可达 |
| 自建 Linux server | ⚠️ 需防火墙放行 | `ufw allow 4532/tcp` / `firewall-cmd --add-port=4532/tcp --permanent` |
| Windows 桌面 | ⚠️ 首次防火墙弹窗 | 系统防火墙会询问是否允许 `node.exe` 监听，选择"专用网络"即可 |

## 环境变量覆盖

Docker / systemd / headless 部署可以不进 UI，直接通过环境变量启用：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `RIGCTLD_ENABLED` | `1` / `true` 启用，`0` 禁用 | 使用 UI 配置 |
| `RIGCTLD_BIND` | 监听地址 | `0.0.0.0` |
| `RIGCTLD_PORT` | 端口 | `4532` |

环境变量优先级高于持久化配置。

## 支持的命令子集

足以覆盖 N1MM / WSJT-X / JTDX / fldigi 的全部核心功能：

- `f` / `F` — 获取 / 设置频率
- `m` / `M` — 获取 / 设置模式 + 带宽
- `v` / `V` — 获取 / 设置 VFO
- `t` / `T` — 获取 / 设置 PTT
- `s` / `S` — 获取 / 设置 Split
- `l` / `L` — Level（`RFPOWER` / `AF` / `SQL`）
- `\chk_vfo`、`\dump_state`、`\get_info`
- `q` — 断开

未实现的命令（包括 memory channel、scan、RIT/XIT、rotator 等）会返回
`RPRT -11`（`RIG_ENIMPL`），客户端会自动回退到不使用这些功能。

## 安全考量

- 协议本身 **无鉴权**——Hamlib 的设计就是这样。务必只在可信网络上开启
  `0.0.0.0` 监听。
- 所有写命令最终走 `PhysicalRadioManager.applyOperatingState` / `setPTT`，与
  Web UI 共享同一条序列化通道，不存在绕过风险。
- 桥接的启停权限由 CASL `execute:RigctldBridge` 控制，可通过 Token 授权给
  OPERATOR 角色。

## 故障排查

| 现象 | 可能原因 |
| --- | --- |
| N1MM 报 "No radio" | 监听地址只开了 `127.0.0.1`，N1MM 却在另一台机器 |
| `EADDRINUSE` | 4532 已被系统的 Hamlib rigctld 占用，请停止系统 rigctld 或改端口 |
| 客户端能连上但读频返回 0 | 电台未连接——桥接仍在运行，会返回 `RIG_EIO`（-5），客户端通常会自动重试 |
| WSJT-X Test CAT 失败 | 查看 UI 客户端列表中的 "最近指令"，确认命令确实收到了；再检查电台连接状态 |
