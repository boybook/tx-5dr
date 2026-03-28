# ICOM 现代电台远程连接开源软件与频谱数据获取整理

## 结论先行

结论需要先拆成三种“连接场景”，否则很容易把“有线”和“无线”混为一谈：

1. **原生 ICOM LAN/WLAN 远程**
   这里的“有线”和“无线”如果都是指电台自带的 **Ethernet / Wi-Fi 网络远程功能**，那么 **应用层协议本质上是同一套**。  
   都是 ICOM/RS-BA1 风格的 UDP 多流协议：控制流、CI-V/串口流、音频流分开，登录、token、重传、心跳也一致。

2. **USB/串口直连**
   如果“有线”指的是 **USB 或串口线直连电脑**，那就 **不是同一套协议**。  
   这时控制面是 **裸 CI-V 串口帧**，音频通常走 USB 声卡，频谱/瀑布图数据也是作为 **CI-V `0x27` 作用域数据**返回，而不是 LAN/WLAN 的 UDP 外层封装。

3. **`wfview server` 转发 USB 电台**
   `wfview` 还能把本地 USB 连接的电台重新包装成网络服务给远端 `wfview` 客户端使用。  
   这不是 ICOM 电台原生协议本体，而是 **`wfview` 自己实现的一层兼容服务器协议**，它在登录响应里直接把连接类型标记成 `"WFVIEW"`。

一句话总结：

- **原生 Ethernet 和原生 Wi-Fi**：一套协议，只是物理链路不同。
- **USB/串口直连 vs 原生 LAN/WLAN**：两套不同的传输协议，但上层很多控制语义仍然复用 CI-V。
- **`wfview server`**：第三种，属于软件兼容层。

---

## 重点开源项目

### 1. `wfview`

- 上游仓库：GitLab，不在 GitHub  
- 本地克隆路径：`~/Documents/coding/wfview`
- 定位：当前最完整的 ICOM 现代机型开源实现之一，同时覆盖
  - USB/串口直连
  - ICOM 原生 LAN/WLAN 远程
  - 本地电台再导出为 `wfview server`
- 优势：
  - 支持 waterfall / spectrum
  - 代码里已经把 ICOM UDP 协议结构体写死，适合逆向协议
  - 同时保留串口 CI-V 直连路径，便于对照“同一业务语义在两种传输层里怎么表现”

### 2. `kappanhang`

- GitHub：`nonoo/kappanhang`
- 本地克隆路径：`~/Documents/coding/kappanhang`
- 定位：更“裸”的 ICOM RS-BA1 协议实现，重点是
  - 登录认证
  - 打开 serial/audio UDP 流
  - 包重传
  - 暴露虚拟串口和 rigctld
- 价值：
  - 对理解 ICOM LAN/WLAN 原生远程协议很有帮助
  - 对照 `wfview` 时可以看出 `wfview` 的 UDP 实现不是拍脑袋写的，而是沿着同一协议家族
- 局限：
  - 代码重点是音频和串口控制，**没有像 `wfview` 那样把 waterfall 作为主功能完整实现**

### 3. `Hamlib`

- GitHub：`Hamlib/Hamlib`
- 定位：通用 CAT/rig 控制框架
- 价值：
  - 在 ICOM 场景里非常适合做频率、模式、PTT 等控制
  - 很多软件链最终都会通过 `rigctld`
- 局限：
  - **不适合作为 ICOM 现代电台 waterfall/频谱数据获取主方案**
  - 它主要是 CAT 控制抽象，不是 ICOM 原生远程 waterfall 协议实现

### 4. 其他说明

- 真正对 **ICOM 现代机型原生远程 + 音频 + CI-V + waterfall** 做到较完整开源实现的，公开项目里最值得看的是 **`wfview`**。
- GitHub 上可作为协议对照的，**`kappanhang`** 非常有价值。
- 如果只是 CAT 控制，不涉及频谱图，`Hamlib` 足够；但一旦要拿 **SDR 频谱图数据**，核心还是得回到 `wfview` 这类项目。

---

## `wfview` 的三条连接路径

### A. USB/串口直连路径

`wfview` 在 `icomCommander::commSetup(... serialPort ...)` 里走 `commHandler`，说明这条链路是典型串口/USB CI-V：

- 入口：`src/radio/icomcommander.cpp`
- 串口层：`src/commhandler.cpp`

这条路径的特征：

- 控制数据：`FE FE ... FD` 的 **CI-V 串口帧**
- 音频：本地音频设备或 USB 声卡
- 频谱/瀑布图：仍是 **CI-V 作用域数据**

`commHandler` 在串口读路径里会直接查找 `0x27 0x00 0x00`，把分段 waterfall 包重新拼起来后再上送给解析层。

这意味着：

- **USB 直连时，waterfall 本质上是 CI-V 数据**
- 不存在 ICOM LAN/WLAN 那层 UDP 外封装

### B. ICOM 原生 LAN/WLAN 路径

`icomCommander::commSetup(... udpPreferences ...)` 会把 `usingNativeLAN` 置为 `true`，然后走 `icomUdpHandler`：

- 控制流：`src/radio/icomudphandler.cpp`
- CI-V 数据流：`src/radio/icomudpcivdata.cpp`
- 音频流：`src/radio/icomudpaudio.cpp`
- 公共 UDP 逻辑：`src/radio/icomudpbase.cpp`
- 包结构体：`include/packettypes.h`

这条路径的特征：

- 登录、token、radio capability、stream request 都走 **控制 UDP 流**
- 之后再单独打开
  - **CI-V 数据流**
  - **音频流**
- waterfall 不是独立第四条流，而是 **封在 CI-V 数据流里**

### C. `wfview server` 转发路径

`wfview` 自己还能对外提供一个兼容服务器。它在登录响应中直接把连接类型写成 `"WFVIEW"`，表明这是它自定义的兼容远程端，而不是原生 ICOM 电台 LAN 登录返回值。

这条路径的意义是：

- 本地电台可能是 USB 接入
- 远端客户端看到的却是网络服务
- 因而 **底层不是 ICOM 原生有线/无线协议本体，而是 `wfview` 再包装后的兼容协议**

---

## ICOM 原生 LAN/WLAN 协议结构

以下内容主要来自 `wfview/include/packettypes.h` 与 `kappanhang/controlstream.go`、`streamcommon.go` 的交叉对照。

### 1. 端口分工

默认端口通常是：

- 控制流：`50001`
- Serial/CI-V 流：`50002`
- Audio 流：`50003`

`kappanhang` 明确把这三个端口常量写死在 `controlstream.go` 中；`wfview` 则通过配置和控制流返回值拿到 CIV/Audio 端口。

### 2. 关键包类型

`wfview/include/packettypes.h` 已经把主要 UDP 包结构体定义清楚了：

- `control_packet`，长度 `0x10`
  - 用于 connect/disconnect/idle/retransmit request 等基础控制
- `ping_packet`，长度 `0x15`
  - type `0x07`
  - 用于 RTT/保活
- `openclose_packet`，长度 `0x16`
  - 用于 serial/CI-V 流的 open/close
- `audio_packet`，长度 `0x18`
  - 音频包头，后跟音频 payload
- `token_packet`，长度 `0x40`
  - token 建立/续租/释放
- `status_packet`，长度 `0x50`
  - 含 `civport` / `audioport`
- `login_response_packet`，长度 `0x60`
  - 登录结果与连接类型
- `login_packet`，长度 `0x80`
  - 编码后的用户名密码
- `conninfo_packet`，长度 `0x90`
  - 既用于 radio 状态通告，也用于 stream request
- `capabilities_packet` + `radio_cap_packet`
  - 枚举可用 radio、音频能力、采样率、波特率、CI-V 地址等

### 3. 会话 ID 与序号

`wfview` 和 `kappanhang` 都把本地 IP + 本地 UDP 端口组合成一个 session id：

- `wfview`: `icomUdpBase::init`
- `kappanhang`: `streamCommon.init`

同时协议里至少有三套序号概念：

1. UDP 外层 `seq`
   用于重传、去重、乱序修复
2. auth/login inner seq
   用于登录/token/stream request 流程
3. stream 内部 send seq
   用于 CI-V 子流或音频子流内部顺序

### 4. 重传机制

这套协议不是单纯“尽力而为”的裸 UDP，而是 **带重传层** 的：

- 单包重传请求：`type 0x01` + 固定长度
- 区间重传请求：`type 0x01` + 可变长度区间列表
- `wfview` 在 `icomUdpBase::dataReceived` 里维护 `txSeqBuf / rxSeqBuf / rxMissing`
- `kappanhang` 在 `pkt0.go` 和 `seqbuf` 里做同样的事

这说明：

- ICOM 原生远程协议虽然跑在 UDP 上
- 但业务上依赖应用层重传保证串口控制和音频尽量连续

---

## `wfview` 的原生 LAN/WLAN 时序流程

下面按 `wfview` 实现整理。

### 阶段 1：控制流发现与握手

`icomUdpHandler::init()` 启动后，先在控制端口发起基础握手：

1. 周期发送 `type 0x03`
   含义类似 “Are you there”
2. 收到 `type 0x04`
   对端在线
3. 客户端发 `type 0x06`
   类似 “Are you ready”
4. 收到对端 `type 0x06`
   进入登录阶段

这部分在 `icomUdpBase::dataReceived()` 和 `icomUdpHandler::dataReceived()` 都能看到。

### 阶段 2：登录

`icomUdpHandler::sendLogin()` 构造 `login_packet`：

- 长度 `0x80`
- 写入编码后的用户名/密码
- 写入客户端名
- `requesttype = 0x00`
- `requestreply = 0x01`

用户名/密码不是明文直接发送，而是先过一遍 `passcode()` 变换。  
`wfview/include/icomudpbase.h` 里有完整算法，`kappanhang/passcode.go` 也是同一套思路。

### 阶段 3：token 建立与续租

登录成功后，服务端返回 `login_response_packet`：

- 带 token
- 带 `connection` 字段
- `wfview` 会根据 `connectionType` 判断链路类型

随后 `wfview` 发送 `token_packet`：

- `magic 0x02` 类似确认/续租
- 定时器周期续租
- 关闭时会发 `magic 0x01` 做 token removal

### 阶段 4：能力枚举

服务端会回 `capabilities_packet` 和多个 `radio_cap_packet`：

- radio 名称
- 音频能力
- CI-V 地址
- 支持采样率
- 波特率
- 能力标志

`wfview` 收到后会展示 radio 列表，并允许选择目标 radio。

### 阶段 5：请求打开 serial/audio 流

`icomUdpHandler::setCurrentRadio()` 会先挑本地两个空闲 UDP 端口：

- 一个预留给 `civLocalPort`
- 一个预留给 `audioLocalPort`

然后 `sendRequestStream()` 发送 `conninfo_packet` 作为 stream request，关键字段包括：

- radio 标识：GUID 或 MAC
- `rxenable / txenable`
- `rxcodec / txcodec`
- `rxsample / txsample`
- `civport = 本地准备好的 UDP 端口`
- `audioport = 本地准备好的 UDP 端口`
- `txbuffer`

服务端收到后，会在 `status_packet` 里回：

- `civport`
- `audioport`

也就是告诉客户端：电台那边实际要监听的远端 UDP 端口。

### 阶段 6：分别建立 CIV 流和音频流

#### CI-V 流

`icomUdpCivData`：

1. 新建 UDP socket
2. 做基础控制握手
3. 发送 `openclose_packet`
   - `data = 0x01c0`
   - `magic = 0x04` 表示 open
4. 之后 serial/CI-V 数据通过 `data_packet` 形式收发

发包时：

- 头部是 `0x15` 字节
- `reply = 0xc1`
- 后面直接拼接 CI-V payload

#### 音频流

`icomUdpAudio`：

1. 新建 UDP socket
2. 做基础控制/心跳
3. 音频包头长度 `0x18`
4. payload 从偏移 `0x18` 开始

`kappanhang` 进一步给出了很清楚的 TX 分片细节：

- 一帧 20ms，48kHz，s16le，mono
- 1920 字节 PCM
- 分成两包发送：
  - `1364` 字节
  - `556` 字节

这和 `wfview` 在 `icomUdpAudio::receiveAudioData()` 里按 `1364` 字节切包的实现是对得上的。

---

## SDR 频谱图 / waterfall 数据到底怎么拿

这是最关键的问题。

## 核心结论

**在 ICOM 现代机型上，频谱/瀑布图数据本质上是 CI-V scope 数据，不是独立的“第四条频谱 UDP 流”。**

也就是说：

- USB/串口直连时：直接从串口 CI-V 里拿
- 原生 LAN/WLAN 时：先进入 serial/CI-V UDP 子流，再从这个子流里拿

### 1. 频谱数据命令族

`wfview` 的 `icomCommander.cpp` 明确把频谱解析锚定在 **CI-V `0x27`** 家族。

代码注释里直接给了关闭 scope 的示例：

- `FE FE <to> <from> 27 11 00 FD`

同时 `parseSpectrum()` 期望 payload 以：

- `0x27 0x00 0x00`

开头。

因此，对上层采集来说，关键不是“找某个神秘的单独频谱端口”，而是：

1. 打开 CI-V 通路
2. 发送/接收 `0x27` 相关作用域命令
3. 对返回分段做重组

### 2. 数据格式

`wfview::parseSpectrum()` 已经把结构说明得很清楚：

- `sequence #1`
  - 只有模式和频率边界信息
  - 不带像素
- `sequence #2 ... #10`
  - 每段约 50 个像素点
- `sequence #11`
  - 最后一个分段，长度更短

常见格式示意：

- 包头固定以 `27 00 00` 起始
- `payloadIn[0]` 表示当前分段序号，BCD
- `payloadIn[1]` 表示总分段数，BCD
- `payloadIn[2]` 表示 scope mode
  - `0x00` center
  - `0x01` fixed
  - `0x02` scroll-center
  - `0x03` scroll-fixed
- 后续字段给出：
  - 起始频率
  - 结束频率或带宽
  - out-of-range 标志
  - 像素强度数组

### 3. `wfview` 的两种归一化处理

这部分是 `wfview` 最值得学的地方。

#### USB/串口方向：分段合并

`commHandler` 在串口接收路径里，如果开启 `combineWf`，会把多个 `0x27 00 00` 分段 waterfall 包先拼成一个大包，再上送解析层。

#### LAN/WLAN 方向：大包拆分

`icomUdpCivData` 在 LAN 模式下，如果启用 `splitWaterfall`，会把一个较大的 LAN waterfall 数据包再拆回多段 CI-V 风格包。

它甚至根据 payload 长度区分不同机型：

- `490`
  - IC-705 / IC-9700 / IC-7300(LAN) / IC-905
- `492`
  - IC-905 10GHz band
- `704`
  - IC-7610 / IC-7851 / IC-R8600

也就是说，`wfview` 为了复用统一的 `parseSpectrum()`，做了一个很重要的规范化动作：

- **串口模式把“多段小包”合并**
- **LAN 模式把“单个大包”拆分**

所以在业务层看来，最后都能落成一套统一的 scope 解析逻辑。

### 4. 像素值语义

`wfview` 的注释说明这些 waveform 数据是：

- 从 `0x00` 到 `0xA0` 一类的强度值
- 每个值对应一个像素柱高度/颜色强度

也就是说：

- 它不是 IQ 原始采样
- 也不是 FFT 复数结果
- 而是 **电台内部已经做完频谱处理后输出的“显示级幅度数据”**

这非常重要：

- 你拿到的是 **用于画瀑布图/频谱图的显示数据**
- 不是能拿来做你自己 SDR 基带解调的 IQ 数据

---

## 有线 vs 无线，到底是不是同一套协议

### 情况 1：有线 = Ethernet， 无线 = Wi-Fi

**是同一套协议。**

依据：

- `wfview` 的 `udpPreferences` 和 `icomUdpHandler` 没有按 “Ethernet/Wi-Fi” 分成两套解析器
- `kappanhang` 对 IC-705 内建 Wi-Fi 和 RS-BA1 server 使用同一套控制/serial/audio UDP 逻辑
- 登录、token、capabilities、conninfo、audio/serial 三流、pkt0 重传、pkt7 ping 都一致

本质差异只在：

- 物理链路
- 网络质量
- 丢包/重传频率

协议层并没有分叉。

### 情况 2：有线 = USB/串口， 无线 = Wi-Fi/LAN

**不是同一套协议。**

差异在传输层非常明显：

- USB/串口
  - 裸 CI-V 帧：`FE FE ... FD`
  - 音频是本地 USB 声卡
  - waterfall 是 CI-V 分段数据
- LAN/WLAN
  - UDP 会话、登录、token、重传、ping
  - CI-V 被塞进 `data_packet`
  - 音频被塞进 `audio_packet`
  - waterfall 通过 CI-V 子流承载

但它们又不是“完全无关”的两套世界，因为：

- 上层电台控制语义大量复用 **CI-V**
- waterfall 数据主体仍然是 **CI-V `0x27` scope 数据**

更准确的说法是：

- **传输协议是两套**
- **控制语义和频谱业务负载有相当高的复用**

### 情况 3：`wfview server`

这条路径要单独看。  
它对客户端暴露的是网络协议，但底层可以接 USB 电台，所以它本质上是：

- 下层：串口/USB CI-V + 本地音频
- 上层：`wfview` 自己封成类 ICOM 远程协议

因此它既不等同于原生 USB，也不完全等同于原生 ICOM LAN/WLAN。

---

## `kappanhang` 对 `wfview` 分析的补充价值

`kappanhang` 很适合用来验证 `wfview` 对 ICOM 原生远程协议的理解是否靠谱。

### 它证明了这些点

1. **控制 / serial / audio 三条流分离**
   - `controlstream.go`
   - `serialstream.go`
   - `audiostream.go`

2. **默认端口就是 50001 / 50002 / 50003**

3. **协议自带重传层**
   - `pkt0.go`

4. **协议自带 ping/latency 跟踪**
   - `pkt7.go`

5. **serial 流 payload 本质上就是 CI-V**
   - `serialstream.go` 会直接收集 `FE FE ... FC/FD` 帧

### 但它没有解决什么

- 它不是拿 waterfall 的最佳参考实现
- 它更像是：
  - 音频
  - 串口控制
  - 认证握手
  - 链路可靠性

所以如果你的目标是“**准确拿到 SDR 频谱图数据结构**”，还是应该把 `wfview` 作为主参考。

---

## 如果你的目标是“自己实现采集”，建议的最短路径

### 路径 A：优先做 USB/串口

最容易验证：

1. 直接拿串口 CI-V 帧
2. 监听 `0x27 0x00 0x00`
3. 复用 `wfview::parseSpectrum()` 的组包逻辑
4. 先把像素数组和频率边界打出来

优点：

- 抓包简单
- 不需要先实现 UDP 登录/token/重传
- 最适合先把 spectrum 数据结构跑通

### 路径 B：再扩到原生 LAN/WLAN

实现顺序建议：

1. 控制流握手
2. login + token
3. capabilities + conninfo
4. 建立 serial/CI-V 子流
5. 先收普通 CI-V
6. 再把 `0x27` scope 数据接进来
7. 最后再做音频

原因：

- waterfall 实际上挂在 CI-V 子流里
- 所以先做 serial/CI-V，比先做音频更关键

### 路径 C：如果只是想给第三方软件远控

直接利用：

- `wfview server`
- `kappanhang`
- `Hamlib rigctld`

不要自己重复造轮子。

---

## 开发级补充：CI-V 频谱数据结构

这一节面向“准备用 Node.js 重新实现”的场景，尽量写成可以直接翻译成代码的形式。

## 1. 数据分层

无论 USB 还是 LAN/Wi-Fi，建议把协议分成三层：

1. **物理/传输层**
   - USB/串口
   - UDP 控制流
   - UDP serial/CI-V 子流
2. **CI-V 帧层**
   - `FE FE <to> <from> <cmd...> FD`
3. **业务语义层**
   - 频率、模式、PTT
   - `0x27` scope / waterfall

Node.js 实现时，最重要的架构决策是：

- **不要把 LAN/Wi-Fi 的 UDP 细节和 `0x27` 频谱解析耦合在一起**
- `0x27` 解析器应该只接受“纯 CI-V payload”

这样你才能同时复用：

- 串口直连采集
- LAN/Wi-Fi 远程采集
- 未来 `wfview server` 或中继器输入

## 2. `scopeData` 目标结构

`wfview/include/wfviewtypes.h` 中最终给 UI 的结构是：

- `valid`
- `data`
- `receiver`
- `mode`
- `fixedEdge`
- `oor`
- `startFreq`
- `endFreq`

对 Node.js，更建议把它扩展成下面这种显式结构：

```ts
export interface IcomScopeFrame {
  valid: boolean;
  receiver: 0 | 1;
  sequence: number;
  sequenceMax: number;
  mode: 0 | 1 | 2 | 3;
  outOfRange: boolean;
  startFreqHz: number;
  endFreqHz: number;
  pixels: Uint8Array;
  rawCivPayload: Buffer;
  transport: 'serial' | 'lan-civ';
  modelHint?: string;
}
```

说明：

- `pixels` 建议显式保留 `Uint8Array`
- `rawCivPayload` 建议保留，方便以后做回放与调试
- `startFreqHz/endFreqHz` 不要只保留 MHz 浮点，避免精度问题

## 3. `0x27` 频谱帧的核心结构

`wfview` 的 `parseSpectrum()` 已经把帧结构说明得比较清楚。

### 3.1 基础识别头

频谱/瀑布图相关 CI-V payload 以这三个字节开头：

```text
27 00 00
```

之后进入分段数据。

### 3.2 分段编号

`wfview` 在 `parseSpectrum()` 里按下面方式取值：

- `payloadIn[0]` = 当前分段序号，BCD
- `payloadIn[1]` = 总分段数，BCD

注意这是 **BCD 编码**，不是普通二进制整数。  
例如：

- `0x01` -> `1`
- `0x11` -> `11`

`wfview` 的实现：

- 低 4 bit 是个位
- 高 4 bit 是十位

Node.js 可直接写：

```ts
function bcdByteToInt(v: number): number {
  return (v & 0x0f) + ((v >> 4) & 0x0f) * 10;
}
```

### 3.3 sequence #1 的结构

`sequence == 1` 时，这一帧是“头帧”，负责携带：

- scope mode
- 起止频率，或中心频率 + span
- out-of-range 标志
- 某些 LAN 情况下，还可能直接带第一段像素

`wfview` 的解释如下：

- `payloadIn[2]` = mode
  - `0x00` = center
  - `0x01` = fixed
  - `0x02` = scroll-center
  - `0x03` = scroll-fixed
- `payloadIn[3 ... 3+freqLen-1]` = 第一个频率字段
- `payloadIn[3+freqLen ... 3+2*freqLen-1]` = 第二个频率字段
- `payloadIn[3 + freqLen * 2]` = out-of-range

对 mode 的解释：

- `mode == 0` 时
  - 第一个频率不是左边界，而是 **中心频率**
  - 第二个频率不是右边界，而是 **带宽一半或 span 参数**
  - `wfview` 会自行转换成 start/end
- `mode != 0` 时
  - 两个频率通常就是边界信息

### 3.4 中间分段

`sequence > 1 && sequence < sequenceMax` 时：

- 这一段主要携带像素
- `wfview` 直接把 `payloadIn.right(payloadIn.length() - 2)` 追加到累计 `data`

也就是说：

- 当前段前 2 个字节是 `seq/seqMax`
- 后面的字节全部视为本段像素

### 3.5 最后一段

`sequence == sequenceMax` 时：

- 追加最后一段像素
- 组帧完成
- 输出 `valid = true`

### 3.6 像素值

像素值是 `Uint8` 强度，不是 IQ，不是复数 FFT。

建议按：

```ts
type SpectrumPixel = number; // 0..255, 实际常见幅度更接近 0..0xA0
```

渲染时再映射到 dB 或颜色。

---

## 开发级补充：频率字段解析

`wfview` 对频率字段的解析依赖它自己的 `parseFreqData()` / `parseFrequency()`，底层仍然是 ICOM 常见的 BCD 频率编码思路。

## 1. 常规长度

多数机型 waterfall 频率字段长度：

- `freqLen = 5`

特殊情况：

- IC-905 某些 10GHz+ 场景：`freqLen = 6`

`wfview` 在 `parseSpectrum()` 中就是这样处理的。

## 2. 建议 Node.js 设计

不要把频率解析写死在 scope 解析器里，建议单独封装：

```ts
function parseIcomBcdFreqLE(bytes: Buffer): number {
  // 返回 Hz
}
```

实现建议：

1. 逐字节取低 nibble / 高 nibble
2. 每个 nibble 视为十进制数字
3. 按 ICOM 频率字段规则拼回 Hz

原因：

- 同一套 BCD 逻辑后面还能复用于频率查询回复
- 便于对 5 字节和 6 字节机型做兼容

---

## 开发级补充：scope 控制命令族

如果你们不只是“被动接收”，而是要在 Node.js 中主动控制 scope，`wfview` 的 `icomCommander.cpp` 已经给出了命令语义。

### 1. 已知命令族

`0x27` 下面至少包含这些 scope 相关功能：

- `funcScopeWaveData`
- `funcScopeOnOff`
- `funcScopeDataOutput`
- `funcScopeMainSub`
- `funcScopeSingleDual`
- `funcScopeMode`
- `funcScopeSpan`
- `funcScopeEdge`
- `funcScopeHold`
- `funcScopeRef`
- `funcScopeSpeed`
- `funcScopeVBW`
- `funcScopeRBW`
- `funcScopeFixedEdgeFreq`
- `funcScopeDuringTX`
- `funcScopeCenterType`

### 2. 一个明确样例

`wfview` 注释里直接给了一个例子，用于关闭 spectrum display：

```text
FE FE <to> <from> 27 11 00 FD
```

这说明：

- `0x27` 是 scope 主命令族
- 后续子命令如 `0x11` 对应某个 scope 控制项

### 3. 实现建议

Node.js 里不要一开始就把所有子命令一次性写死。建议：

1. 先支持被动解析 `0x27 00 00`
2. 再做最小的主动控制：
   - 开关 scope
   - 开关 data output
3. 后面再补：
   - mode
   - span
   - ref
   - speed

因为对“拿到频谱图”最关键的是 **数据输出开启**，不是把每个 UI 控件都实现出来。

---

## 开发级补充：USB/串口路径时序

这一段建议直接按“可实现模块”理解。

### 1. 输入流

串口收到原始字节流：

```text
FE FE <to> <from> ... FD
```

### 2. 串口帧切分器

你需要一个 `CiVFrameAssembler`：

- 等待 `FE FE`
- 持续读到 `FD`
- `FC` 视为 collision/异常帧

这和 `wfview/src/commhandler.cpp`、`kappanhang/serialstream.go` 的做法一致。

### 3. 频谱分段识别

当一帧内检测到：

```text
27 00 00
```

进入 scope 解析逻辑。

### 4. 分段重组

对每个 receiver 维护一个组装状态：

```ts
interface ScopeAssemblyState {
  receiver: number;
  expectedMax?: number;
  mode?: number;
  startFreqHz?: number;
  endFreqHz?: number;
  outOfRange?: boolean;
  chunks: Buffer[];
  lastSeq?: number;
  updatedAt: number;
}
```

流程：

1. 收到 `seq=1`
   - 初始化 assembly
   - 记录 mode / freq / oor
2. 收到 `seq=2..n-1`
   - 按序追加像素
3. 收到 `seq=n`
   - 收尾
   - 拼成完整 `Uint8Array`
   - 发出 `IcomScopeFrame`

### 5. 超时策略

建议：

- `seq=1` 后如果 300~800ms 内没收齐，丢弃本轮
- 如果收到新的 `seq=1`，直接重置旧状态

原因：

- scope 数据是持续刷新的，旧帧过期没有补价值

---

## 开发级补充：LAN/Wi-Fi 路径时序

这部分是 Node.js 重写里最容易写乱的地方。

### 1. 控制流状态机

建议独立成状态机：

```ts
type ControlState =
  | 'idle'
  | 'discovering'
  | 'login-sent'
  | 'login-ok'
  | 'token-ok'
  | 'capabilities-known'
  | 'stream-requested'
  | 'stream-open';
```

### 2. 基本流程

1. 控制 socket bind 本地随机端口
2. 发 `type 0x03`
3. 收 `type 0x04`
4. 发 `type 0x06`
5. 收 `type 0x06`
6. 发 `login_packet`
7. 收 `login_response_packet`
8. 发 `token_packet`
9. 收 `capabilities_packet` / `radio_cap_packet`
10. 选 radio
11. 发 `conninfo_packet` 申请 CI-V / audio 子流
12. 收 `status_packet`
13. 建立 `icomUdpCivData` 等价子流
14. 从 CI-V 子流中抽取 `0x27`

### 3. 为什么说 waterfall 仍然是 CI-V

在 LAN 模式里：

- 外层是 UDP `data_packet`
- `datalen` 指示后面有多少字节业务数据
- `r.mid(0x15)` 之后，拿到的还是 CI-V 语义 payload

在 `icomUdpCivData::dataReceived()` 里，`wfview` 对 LAN 收到的大包做的事不是“专门解频谱 UDP 协议”，而是：

1. 找到 `27 00 00`
2. 判断这是不是 waterfall
3. 如果是，把大 LAN 包拆成多个小的 CI-V 风格片段
4. 再 `emit receive(wfPacket)`

所以 Node.js 最佳设计应是：

- `LanCivTransport` 负责从 UDP 子流提取 CI-V payload
- `IcomScopeParser` 完全不关心这个 payload 来自串口还是 UDP

---

## 开发级补充：LAN 模式下的大包拆分规则

这部分是 `wfview` 很有价值的经验。

## 1. 触发条件

`icomUdpCivData` 收到大于 21 字节的 `data_packet` 后，会检查：

- 包内是否存在 `27 00 00`
- 后续是否以 `FD` 结束

## 2. 已知长度

`wfview` 已内置了几种已知 waterfall 长度：

- `490`
  - IC-705 / IC-9700 / IC-7300(LAN) / IC-905
- `492`
  - IC-905 10GHz
- `704`
  - IC-7610 / IC-7851 / IC-R8600

## 3. 拆分策略

`wfview` 的思路不是按协议字段逐个解释，而是“按经验格式切片”：

- 先复制统一头部
- 人工改写 `seq / seqMax`
- 第 1 段取头部和频率信息
- 中间段每段取固定长度像素块
- 末段取剩余尾块
- 给每段补上 `FD`

说明：

- ICOM LAN 返回的 waterfall 实际上可能是“单个聚合包”
- 但它在业务上仍对应“多段 scope 数据”

### 对 Node.js 的建议

把这部分实现成单独适配器：

```ts
function splitLanWaterfallAggregateToCivSegments(buf: Buffer): Buffer[] {
  // 输入：LAN serial/CI-V 子流里拿到的大包业务负载
  // 输出：多个标准化后的 CI-V scope segment
}
```

这样后面仍然复用同一个 `parseScopeSegment()`。

---

## 推荐的 Node.js 模块拆分

下面是一套比较稳的拆分。

### 1. 传输层

```ts
IcomSerialTransport
IcomLanControlTransport
IcomLanCivTransport
IcomLanAudioTransport
```

职责：

- socket / serialport 打开关闭
- 重传、保活、握手
- 不做 scope 语义解析

### 2. CI-V 层

```ts
CiVFrameAssembler
CiVFrameParser
CiVCommandBuilder
```

职责：

- 串口字节流切帧
- 从 payload 判定命令族
- 统一输出：

```ts
interface CiVFrame {
  raw: Buffer;
  to: number;
  from: number;
  command: Buffer;
  payload: Buffer;
}
```

### 3. Scope 层

```ts
IcomScopeSegmentParser
IcomScopeAssembler
IcomLanScopeAggregateSplitter
```

职责：

- 把单段 `0x27` 解析成 segment
- 把多个 segment 组装成完整 frame
- LAN 大包先拆分成 segment

### 4. 应用层

```ts
IcomClient
IcomScopeService
IcomRadioStateStore
```

职责：

- 把 transport 与 parser 组合起来
- 输出订阅事件

---

## 推荐的 Node.js 事件模型

建议所有关键节点都发事件，否则排障会非常痛苦。

```ts
type IcomEvent =
  | { type: 'control-state'; state: string }
  | { type: 'civ-frame'; frame: CiVFrame }
  | { type: 'scope-segment'; seq: number; seqMax: number; receiver: number }
  | { type: 'scope-frame'; frame: IcomScopeFrame }
  | { type: 'packet-loss'; stream: 'control' | 'civ' | 'audio'; count: number }
  | { type: 'rtt'; ms: number }
  | { type: 'warning'; message: string };
```

尤其建议保留：

- `scope-segment`
- `scope-frame`

因为 scope 问题很多时候不是“没收到”，而是“收到了但重组逻辑错了”。

---

## 推荐的最小实现顺序

如果你们准备用 Node.js 重写，建议严格按下面顺序做。

### 版本 1：USB/串口拿到完整频谱

1. 串口字节流切帧
2. 识别 CI-V 帧
3. 识别 `0x27`
4. 实现 `parseScopeSegment`
5. 实现 `assembleScopeFrame`
6. 能输出 `pixels + start/endFreq`

### 版本 2：LAN/Wi-Fi 控制 + CI-V 子流

1. 控制流握手
2. login/token
3. 申请 serial 子流
4. 收到普通 CI-V
5. 把 `0x27` 接进 scope 解析

### 版本 3：LAN 聚合 waterfall 兼容

1. 识别 aggregate 包
2. 拆回 segment
3. 复用 scope parser

### 版本 4：音频与完整远程

1. 音频子流
2. TX 分片
3. packet loss / retransmit 统计
4. UI 或 WebSocket 输出

---

## 实现时最容易踩的坑

### 1. 把 BCD 当二进制整数

最典型错误：

- `0x11` 被当成 `17`

实际上它表示：

- `11`

### 2. 把像素数组当 IQ

这是错误方向。

`0x27` scope 数据是：

- 电台内部处理后的显示级频谱柱数据

不是：

- IQ 基带流

### 3. center 模式下直接把两个频率字段当 start/end

`mode == 0` 时不能这样做。  
要按 `wfview` 的逻辑把中心频率和 span 转成边界。

### 4. LAN 下直接把大包喂给 scope parser

如果输入还是 aggregate 大包，而你的 parser 只会吃标准 segment，就一定会错。  
LAN 模式往往需要先 `split`.

### 5. 不做 assembly timeout

scope 是连续刷新的。  
如果不做超时与重置，很容易把上一帧残留和下一帧混在一起。

---

## 面向 Node.js 的伪代码骨架

```ts
class IcomScopeService {
  private assemblies = new Map<number, ScopeAssemblyState>();

  handleCivPayload(payload: Buffer, transport: 'serial' | 'lan-civ') {
    if (!isScopePayload(payload)) return;

    const seg = parseScopeSegment(payload);
    if (!seg) return;

    const key = seg.receiver;
    const frame = this.mergeSegment(key, seg, transport);
    if (frame) this.emitScopeFrame(frame);
  }

  handleLanAggregate(payload: Buffer) {
    const segments = splitLanWaterfallAggregateToCivSegments(payload);
    for (const seg of segments) {
      this.handleCivPayload(seg, 'lan-civ');
    }
  }
}
```

对应的辅助函数建议至少包括：

```ts
isScopePayload(buf: Buffer): boolean
parseScopeSegment(buf: Buffer): ParsedScopeSegment | null
splitLanWaterfallAggregateToCivSegments(buf: Buffer): Buffer[]
parseIcomBcdFreqLE(buf: Buffer): number
bcdByteToInt(v: number): number
```

---

## 建议的测试样本策略

你们重写时，强烈建议先积累三类样本文件：

1. USB 串口原始 CI-V 录包
2. LAN CI-V 子流录包
3. LAN aggregate waterfall 包

每个样本都保存：

- 原始 hex
- 期望 `sequence / sequenceMax`
- 期望 `mode`
- 期望 `startFreqHz / endFreqHz`
- 期望像素数

然后做 golden tests。

对于 scope 重写，这比先写 UI 重要得多。

---

## 最终判断

### 1. 关于协议是否相同

- **原生 Ethernet 与原生 Wi-Fi**：相同协议
- **USB/串口 与 原生 LAN/WLAN**：不同协议
- **`wfview server`**：软件兼容层，不等同于原生协议

### 2. 关于 SDR 频谱图数据

- 频谱图数据并不是独立网络流
- 它本质上是 **CI-V scope 数据**
- 关键命令族是 **`0x27`**
- `wfview` 已经给出了最有参考价值的：
  - 组包
  - 分段编号
  - 起止频率解释
  - 像素数组抽取

### 3. 关于项目优先级

- **第一优先级：`wfview`**
- **第二优先级：`kappanhang`**
- **第三优先级：`Hamlib`，只适合 CAT，不适合 waterfall 主通路**

---

## 这份整理主要参考的本地源码

### `wfview`

- `~/Documents/coding/wfview/include/packettypes.h`
- `~/Documents/coding/wfview/include/icomudpbase.h`
- `~/Documents/coding/wfview/src/radio/icomudphandler.cpp`
- `~/Documents/coding/wfview/src/radio/icomudpcivdata.cpp`
- `~/Documents/coding/wfview/src/radio/icomudpaudio.cpp`
- `~/Documents/coding/wfview/src/radio/icomcommander.cpp`
- `~/Documents/coding/wfview/src/commhandler.cpp`
- `~/Documents/coding/wfview/src/radio/icomserver.cpp`

### `kappanhang`

- `~/Documents/coding/kappanhang/README.md`
- `~/Documents/coding/kappanhang/controlstream.go`
- `~/Documents/coding/kappanhang/streamcommon.go`
- `~/Documents/coding/kappanhang/pkt0.go`
- `~/Documents/coding/kappanhang/pkt7.go`
- `~/Documents/coding/kappanhang/serialstream.go`
- `~/Documents/coding/kappanhang/audiostream.go`

### 额外说明

- `wfview` 主仓库实际在 GitLab，不在 GitHub
- GitHub 维度上，最有对照价值的是 `kappanhang` 与 `Hamlib`
