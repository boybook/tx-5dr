# 自动上传主线程性能验证

证据日期：2026-10-10。范围仅为同步插件自动上传，不是手动同步性能承诺。
本轮保留 checkpoint、ledger、KVStore 和 Host 队列格式，没有迁移、新增 worker
或任务框架。远端 API 请求、确认语义和手动入口只做兼容性回归。

## 方法

在 macOS arm64、Node 26.9.0、`NODE_ENV=production` 下，使用真实 ADIF 日志存储、
原有扫描／重写 worker 和插件 KV／文件安全写入。每个规模预置日志及历史同步状态，
每个 Provider 前后各测五次单条自动上传，记录 1 ms 心跳最大间隔、总耗时、
完整快照次数、内存采样和 checkpoint 写入量。规模为 10,000／50,000 条，另预置
六条独立待上传记录供五次单独运行和一次四服务并发。

请求响应来自 fixture；LoTW 使用真实 RSA 2048 位私钥签名及 gzip，证书内容为
合成 envelope，因此这不是 LoTW 远端证书信任验证。日志适配器重现旧／新的公开
快照隔离路径，Factory/Guard 测试单独验证它的复制次数与安全边界。未运行真实
电台，也没有以此声称 RF 时序或音频连续性得到硬件验证。

前后为同机顺序运行。部分构建／回归与采样重叠，绝对延迟受到竞争和 GC 影响；
五次最大间隔的中位数用于本次比较，不是设备性能保证。RSS 为阶段末采样，包含
fixture、缓存和旧对象，不能当作生产增量峰值。网络／磁盘等待与主线程停顿分别
计量；失败及超时保留在数据中。

## 单条自动上传结果

下表为每次运行最大心跳间隔的五次中位数。失败数为五次调用的失败次数；包含
失败的基线不能单独证明成功路径达到同等比例。

| 日志基线 | Provider | 优化前 | 优化后 | 间隔降低 | 调用失败数 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 10,000 | QRZ | 1238.03 ms | 94.09 ms | 92.4% | 0 → 0 |
| 10,000 | LoTW（真实签名） | 824.21 ms | 63.50 ms | 92.3% | 0 → 0 |
| 10,000 | Wavelog | 18.25 ms | 12.08 ms | 33.8% | 0 → 0 |
| 10,000 | Club Log（含 flush） | 148.58 ms | 44.13 ms | 70.3% | 0 → 0 |
| 50,000 | QRZ | 2236.96 ms | 376.38 ms | 83.2% | 1 → 0 |
| 50,000 | LoTW（真实签名） | 2123.99 ms | 524.85 ms | 75.3% | 1 → 0 |
| 50,000 | Wavelog | 48.11 ms | 12.41 ms | 74.2% | 0 → 0 |
| 50,000 | Club Log（含 flush） | 472.13 ms | 220.34 ms | 53.3% | 0 → 0 |

10K 的 QRZ／LoTW 间隔降低超过 90%；50K 及其余 Provider 未全部达到目标。
优化后所有五次单独调用均成功，QRZ／LoTW 的无过滤完整快照次数均为零。
没有为凑齐比例增加迁移、存储 API 或 worker。

Wavelog 单条正常上传的 checkpoint 写入从三次降为两次。50K 基线下每次输入
字节约从 20.47 MB 降为 13.65 MB，仍是完整旧格式文件；备份、文件系统开销
不包含在该数字内。50K 时总耗时中位数约 251 → 247 ms，改善主要是分散同步
CPU 和减少一次写入，并非消除全部历史数据处理。

50K 四服务并发：无过滤完整快照次数 3 → 0，最大心跳间隔约
21,288 → 442 ms，总耗时约 260 → 36 s。基线有一次 QRZ 本地写回失败，
优化后的四个结果均成功；此场景只有一次采样，不作稳定比例结论。

## 仍然存在的成本

- QRZ／LoTW 的现有 worker 仍一次返回完整扫描 DTO。原协议不变，消息反序列化、
  分配和 GC 仍可能出现数百毫秒停顿。单条 sent-state 更新仍要求完整 ADIF
  rewrite、备份／校验，50K 单独调用总耗时中位数约 15–16 s。分片不等于减少
  全部总工作量；物理 TX 维护栅栏仍覆盖完整事务，不承诺消除所有等待。
- Club Log 缓存减少重复读取，现有同步 KV 写入仍完整校验、复制、JSON 编码。
  50K 成功 ledger 下仍有约 220 ms 的中位数最大间隔；首次加载另有完整复制。
- Wavelog 保留单文件格式，冷恢复的 JSON.parse、完整文件 Buffer 和数据拷贝仍
  有开销；大集合编码分片不意味着总字节数降为本次变动量。
- Host 积压队列保持原语义。在一项失败 Provider 的 10K／50K 队列上新增一条
  QSO，另一次测量的最大心跳间隔约 112／718 ms。该热点只测量，没有改动
  队列持久化或调度。这是明确残余，不能宣称自动上传完全没有阻塞。
- 冷日志打开仍使用原初始化路径；本轮未把手动同步或整个启动架构纳入优化。

## 回归与复现

按 ID 查询覆盖空集合、重复／未知 ID、其他条件交集和不扫描全记录数组；
Factory/Guard fixture 覆盖最多 1,000 个有效 ID、输入隔离以及仅一次边界复制。
自动提交／恢复覆盖 100 条分批、局部失败保留 receipts、移动／删除记录、用户
编辑、并发确认字段、旧快照去重和原 Host 队列失败保留。分片文档测试比较实际
重写字节和外部 runtime ID，确认定时器能在准备／安装时运行。Wavelog 验证意图
与最终结果的两次 durable 写入，并在重启后跳过已成功记录。

构建、lint、SDK packed consumer、内置插件 277 项测试、Web 862 项测试、虚拟
电台 7 项测试及日志性能 2 项测试通过。全量服务器单位测试中 2,208 项通过，
一项 ADIF rewrite audit 在并行负载下达到原有 5 s 超时；随后单独复跑该文件的
58 项测试通过，未修改原测试超时来掩盖问题。较早并行阶段还有多项日志测试
超时，复跑后以后一轮结果为准。Node 26 的 Web 测试继续使用已确认的
`NODE_OPTIONS=--no-experimental-webstorage` 环境开关。

基准工具：`scripts/benchmarks/auto-upload.mjs`。先构建，再运行：

```bash
NODE_ENV=production LOG_LEVEL=error node scripts/benchmarks/auto-upload.mjs --output /tmp/auto-upload-after.json
NODE_ENV=production LOG_LEVEL=error node scripts/benchmarks/auto-upload.mjs --queue-only --output /tmp/auto-upload-queue.json
```

对照构建可使用 `--before --code-root <directory>`，该目录包含保存的 `server/`
和 `builtin/` 编译产物，并能解析本地依赖。工具只操作自己的临时合成数据，
所有网络响应均由脚本 fixture 提供。未发布、部署或修改站点仓库。

本次原始数据保留在 `/tmp/tx5dr-auto-optimization-before.json`、
`/tmp/tx5dr-auto-optimization-after.json` 和
`/tmp/tx5dr-auto-optimization-queue-after.json`；这些临时文件不是长期存储。
