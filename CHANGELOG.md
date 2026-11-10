# Changelog

## 0.1.0 (2026-11-10)

首个版本。在小米蓝牙语音遥控器（Device Information 型号 `RC001`，VID `0x2717` /
PID `0x32B8`）上完成真机端到端验收。

### 语音

- ATVV 协议状态机：能力协商、开麦/关麦、起流/停流、ADPCM 同步
- IMA/DVI ADPCM 解码器：与独立标准分段实现**逐样本误差 0**（16328 点交叉验证）
- 帧切分（frameSize 来自能力协商）、3 点平滑 + 3 dB 增益
- 静默看门狗（默认 1.2 s）与最短语音时长过滤（默认 300 ms）
- 优先复用 DSH `speechToText`；provider 未准备时自动回退 `externalAsrCommand`
- 随包附带 `scripts/paraformer-cli.py`（sherpa-onnx Paraformer 中文，0.8 s 加载 / 0.03 s 单句）

### 设备

- profile 驱动的识别：`xiaomi-arn9`（含 `RC001` 型号别名）、`xiaomi-rc003`、`generic-atvv`
- 匹配优先级：Model Number 95 > 蓝牙名精确 90 > VID+PID 85 > 名字包含 70 > 服务 UUID 60 > 通用回落 40
- 纯 Node BlueZ 客户端（dbus-next），零原生模块
- 设备扫描预筛 + 模型读取 1.5 s 超时：118 台设备从 **60 s 降到 0.6 s**

### 按键

- `lib/evdev_helper.py` 独占输入设备（`EVIOCGRAB`）并转发非语音键到虚拟键盘
- 语音键双码拦截（`KEY_F5` 62 / `KEY_F6` 63），避免浏览器把 F5 当刷新
- 确认键 → 回车；方向/返回/主页/菜单/音量原义转发

### 集成

- 设置面板：状态、设备、profile 列表、HID 插件诊断、语音 provider 准备阶段、日志
- HTTP 路由 `/dsh-bt-remote-voice/{state,scan,connect,disconnect,log}`
- Agent 工具 `bt_remote_voice`（status / scan / connect / disconnect / open_mic / close_mic / recent_log）
- 市场索引条目通过 `@deepseek-ai/dsh-plugin-market-index` 官方校验器

### 已知限制

- 仅 Linux（macOS / Windows 需替换 `lib/bluez.js` 传输层，状态机可复用）
- 一次只连一台遥控器
- 必须禁用 BlueZ 的 HID host 插件（`DisablePlugins = input`），否则设备语音走厂商加密通道
- 按键通道需要 evdev / uinput 权限（udev `uaccess` 规则或 `input` 组）
