# Icom USB/ACC 12 kHz IF 解调 Spike（Phase A）

验证：电台菜单手动切到 `ACC/USB Output Select = IF` 后，TX-5DR 用软件 SSB 解调再走现有 12 kHz FT8/频谱路径，是否比 AF+AGC 更能保住强台旁的弱信号。

**不是** WLAN 能力 `audio_if_mode`（CI-V `AFIF*` 音频口路由）。本路径是 **USB 声卡 PCM 上的 IF → 软件解调**。

## 启用方式

### 频谱面板快捷切换（推荐）

主界面频谱图右上角、设置齿轮左侧有 **AF / IF** 按钮（需管理员权限）：

- 显示当前状态；点击切换到另一状态
- 切到 **IF** 时请同步把电台 `ACC/USB Output Select` 设为 **IF**
- 仅改信号类型会热重载解调器，不重启引擎

### 配置文件（无 UI 时）

在激活 Profile 的 `audio` 配置中设置：

```json
{
  "inputSignalType": "icom-12k-if",
  "ifCenterHz": 12000
}
```

- `inputSignalType` 默认 `af`（与现网一致）
- `ifCenterHz` 默认 `12000`；实测中心偏差时可微调
- 仅影响 **input**；TX 仍走 AF / USB MOD
- 热更新：改配置后会重建/重配解调器（日志：`IF demod enabled` / `IF demod reconfigured`）

电台侧（示例 IC-7300/705 类）：

1. `ACC/USB Output Select` → **IF**
2. 模式 USB-D（或常用 FT8 模式）
3. USB CODEC 仍接 TX-5DR 输入（通常 48 kHz PCM 承载 12 kHz IF）

切回 AF 对比时：电台菜单改回 AF，配置改 `inputSignalType: "af"`（或不写该字段）。

## 对比实验步骤

同一 USB CODEC、同一频点、尽量同一时间段：

| 轮次 | 电台 Output Select | TX-5DR `inputSignalType` | 电台 AGC | 记录 |
|------|-------------------|--------------------------|----------|------|
| A | AF | `af` | 常用（Fast/Mid） | 弱台解出数、瀑布底噪 |
| B | IF | `icom-12k-if` | 同 A（菜单 IF 时 AGC 主要作用在 AF 链） | 同上 |
| C | AF | `af` | **Off** | 确认 IF 是否仍优于「已优化 AF」 |

场景：通带内有 **近距离强台** + **清晰可见但 AF 模式下难解/掉解的弱台**。

观察：

1. 瀑布是否落在 **0–3 kHz**（IF 解调正确）；若能量仍在 ~12 kHz 附近，说明未开解调或电台未切 IF。
2. 同场景 FT8 解出弱台数量 / 连续解出稳定性。
3. CPU：时隙内是否明显变重（Phase A 不优化算力）。

## 自动化验证（合成信号）

```bash
yarn workspace @tx5dr/server exec vitest run src/audio/__tests__/IcomIfSsbDemodulator.test.ts
```

覆盖：

- 12 kHz IF 上强+弱双音 → USB 解调后弱音相对功率不明显劣于输入
- 错误把 IF 当 AF（不解调）时，基带能量不在预期 AF 音上（可观测失败）

## 手工对比结论模板

> 填表后把结论贴回 PR / issue；本机无电台时仅保留合成测试通过记录。

| 日期 | 机型 | 频段 | 轮次 A 弱台解出 | 轮次 B 弱台解出 | 轮次 C 弱台解出 | 是否继续 Phase B/C |
|------|------|------|----------------|----------------|----------------|-------------------|
| YYYY-MM-DD | e.g. IC-705 | 14 MHz | | | | 是 / 否 / 待定 |

备注：

- （瀑布、AGC、`ifCenterHz` 微调、异常日志等）

### 当前仓库状态（2026-07-22）

- Phase A 代码路径已合入分支 `feat/icom-usb-if-demod`：contracts + `IcomIfSsbDemodulator` + `AudioStreamManager` 接入；频谱面板 AF/IF 快捷切换。
- IF 音频瀑布额外使用 Blackman 窗 + 显示侧旁瓣收紧（不改解码路径）；切回 AF 恢复 Hann。
- 合成信号单测：**通过**（弱音动态范围保留；误当 AF 可观测失败）。
- 电台实机 AF vs IF 对比：**待有 Icom USB IF 环境的操作员填写上表**。无实机前不得宣称「强台旁弱信号一定优于 AF」。
