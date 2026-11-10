# dsh-bt-remote-voice

把一台**蓝牙语音遥控器**变成 DeepSeek Harness 的按住说话输入框。

按住遥控器上的语音键说话 → 松手 → 遥控器自己的麦克风录下的语音直接变成文字。
不依赖电脑麦克风，不依赖云服务，不编译任何原生模块。

> 已经真机验证的设备：**小米蓝牙语音遥控器（ARN9）**、**小米蓝牙遥控器 2 Pro（RC003）**。
> 任何暴露标准 ATVV 服务的遥控器都可以用 `profiles/generic-atvv.json` 接入。

---

## 它解决什么问题

大多数「语音输入」方案假设你的电脑有一支能用的麦克风。桌面迷你主机、工控机、
接了 HDMI 显示器的开发板上通常没有——但很多人手边就有一台蓝牙语音遥控器。

这类遥控器的语音不走标准 HFP/HSP，而是走 **ATVV（Android TV Voice over BLE）**：
按住语音键后，遥控器用 IMA/DVI ADPCM 把 16 kHz 音频压成 120 字节一帧，通过
GATT notify 推给主机。本插件把这套协议实现出来，接上 DSH 的语音识别服务。

## 前置条件（Linux）

### 1. 禁用 BlueZ 的 HID host 插件

**这一步是必须的。** 如果 BlueZ 把遥控器挂成 HID 键盘，设备固件会把语音切到
厂商私有加密通道（实测熵 7.67 bit/byte，ADPCM/Opus 都解不出来），标准 ATVV
收不到任何音频。

```ini
# /etc/bluetooth/main.conf
[General]
DisablePlugins = input
```

```bash
sudo systemctl restart bluetooth
```

代价：遥控器的方向键/确认键不再自动变成标准键盘事件。本插件用 `lib/evdev_helper.py`
在 evdev 层把它们重新接出来（见下方「按键」），所以确认键仍然能当回车用。

### 2. 让当前用户能读 evdev、写 uinput

```bash
# /etc/udev/rules.d/60-dsh-bt-remote-voice.rules
KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
SUBSYSTEM=="input", KERNEL=="event*", GROUP="input", MODE="0660"
```

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo usermod -aG input "$USER"      # 重新登录生效
```

不配也能用，只是按键通道会退化：F5 仍会漏到桌面（浏览器里表现为刷新页面），
确认键也不会被转发。

### 3. 配对并连接遥控器

```bash
bluetoothctl
> scan on
> pair E8:55:40:B1:C6:1A
> trust E8:55:40:B1:C6:1A
> connect E8:55:40:B1:C6:1A
```

## 安装

```bash
# 从插件市场
dsh plugin --profile desktop add dsh-bt-remote-voice

# 从 GitHub
dsh plugin --profile desktop add github:Retrasts/dsh-bt-remote-voice

# 本地开发
dsh plugin --profile desktop add link:/path/to/dsh-bt-remote-voice
```

装好后 **完整重启 DSH**（bundle 重新挂载时 Node 的 ES 模块缓存不会失效）。

本地 `link:` 安装已在 `web` profile 上验证过：依赖写入 `dependencies`、符号链接建好、
`import('dsh-bt-remote-voice')` 能拿到 `name` / `PLUGIN_VERSION` / `apply`，
全部子模块（`lib/bluez`、`lib/keys`、`lib/devices`…）也能按 exports 解析。
`pnpm` 若因 profile 里其它包含构建脚本而报 `ERR_PNPM_IGNORED_BUILDS`，加
`--ignore-scripts` 即可，本插件不需要构建。

## 本机验证（不需要遥控器也能跑的部分）

```bash
node --test                      # 19 项单元 + 加载测试
npm run verify:adpcm             # ADPCM 解码器与标准分段实现逐样本对比（期望误差 0）
npm run e2e -- --seconds 30      # 端到端：真实 BlueZ + 本地 Paraformer，不用重启 DSH
npm run live -- --address <MAC>  # 只录音存 WAV，不做识别
```

`verify:adpcm` 的结果应该长这样：

```
参考样本 16328，本插件样本 16328
逐样本对比: 最大误差 0, 误差 RMS 0.00
✅ 通过：本插件解码结果与标准分段参考实现逐样本一致（误差 0）
```

## 使用

1. 打开「设置 → 插件 → 蓝牙遥控器语音」，确认状态是 `ready`，设备匹配到 profile
2. 按住遥控器语音键，说一句话，松开
3. 语音自动识别，识别结果通过插件事件交给界面

面板上还有「连接 / 断开 / 刷新」，日志区可以看到每一步协议往来。

## 支持的设备

| profile | 设备 | 备注 |
|---|---|---|
| `xiaomi-arn9` | 小米蓝牙语音遥控器（普通款） | VID 0x2717 / PID 0x32B8，语音键上报 F5 或 F6 |
| `xiaomi-rc003` | 小米蓝牙遥控器 2 Pro | 协议与 ARN9 相同，多一个 TV 键 |
| `generic-atvv` | 任意暴露 `AB5E0001…` 的 ATVV 设备 | 按键码可能需要按实际校准 |

### 加一款新设备

不用改代码，加一个 JSON：

```json
{
  "id": "my-remote",
  "name": { "zh": "我的遥控器", "en": "My remote" },
  "match": {
    "bluetoothNames": ["My Remote"],
    "hid": { "vendorId": 4660, "productId": 22136 }
  },
  "voice": {
    "protocol": "atvv",
    "codec": "ima-adpcm",
    "sampleRate": 16000,
    "frameSize": 120,
    "transmitUuid": "ab5e0002-5a21-4f05-bc7d-af01f617b664",
    "audioUuid": "ab5e0003-5a21-4f05-bc7d-af01f617b664",
    "controlUuid": "ab5e0004-5a21-4f05-bc7d-af01f617b664"
  },
  "keys": { "voice": [62, 63], "enter": 28 }
}
```

匹配优先级：`deviceInfoModel` > 蓝牙名精确 > VID+PID > 服务 UUID。

## 按键

`lib/evdev_helper.py` 独占遥控器的输入设备节点，把非语音键转发到一个虚拟键盘：

| 遥控器键 | 默认行为 |
|---|---|
| 语音键（F5/F6） | 拦截，不进桌面，只触发录音 |
| 确认 | 回车 |
| 方向键 | 方向键 |
| 返回 | `KEY_BACK` |
| 主页 / 菜单 | `KEY_HOME` / `KEY_COMPOSE` |
| 音量 | 系统音量 |

## Agent 工具

插件注册了 `bt_remote_voice` 工具：

```
status      诊断：profile、设备、HID 插件状态、最近错误
scan        列出本机 BlueZ 里能匹配的设备
connect     连接（可指定 MAC）
disconnect  断开
open_mic    手动开麦
close_mic   手动收麦并识别
recent_log  最近日志
```

## HTTP 路由

面板与外部脚本共用，前缀 `/dsh-bt-remote-voice`：

```
GET  /state        诊断快照
GET  /scan         设备扫描
POST /connect      连接
POST /disconnect   断开
GET  /log          最近 200 条日志
```

## 协议参考

```
Service   AB5E0001-5A21-4F05-BC7D-AF01F617B664
Transmit  AB5E0002  write   主机 -> 遥控器
Audio     AB5E0003  notify  遥控器 -> 主机（IMA ADPCM 帧）
Control   AB5E0004  notify  遥控器 -> 主机
```

| 方向 | 字节 | 含义 |
|---|---|---|
| 主机→遥控器 | `0A 01 00 00 03 03` | 请求能力 |
| 主机→遥控器 | `0C 00` | 开麦（版本 ≥ 1.0） |
| 主机→遥控器 | `0D <session>` | 关麦 |
| 遥控器→主机 | `0B …` | 能力：version / codec / frameSize |
| 遥控器→主机 | `08` | 请求开麦 |
| 遥控器→主机 | `04 <interaction> <codec> <session>` | 起流 |
| 遥控器→主机 | `00` | 停流 |
| 遥控器→主机 | `0A …` | ADPCM 同步（predictor, stepIndex） |

实测能力响应：`0B 01 00 02 03 00 78 00 00` → version `0x0100`、codec `0x02`
（16 kHz）、frameSize `120`。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志停在 `TX GET_CAPABILITIES`，无 `CAPS` | HID 插件未禁用，或设备未连接 | 检查 `DisablePlugins = input`；`bluetoothctl info` 看 Connected |
| 有 `CAPS`、`MIC_OPEN`、`STREAM_START`，但 `samples=0` | 按键没触发录音 | 确认语音键确实被按住；看面板日志里有没有 `语音键 code=…` |
| 按语音键时浏览器刷新 | 语音键的 F5 漏到桌面 | 配 udev 规则让插件能独占设备；或检查 `voiceKeys` 是否覆盖了实际上报的 code |
| 识别结果为空 | DSH 语音识别服务未启用 | 启用 experimental speech-to-text 插件 |
| `打不开 /dev/uinput` | 权限不足 | 见「前置条件 2」 |

## 目录

```
host.js                 插件入口：设备连接、语音会话、HTTP 路由、Agent 工具
client.js               设置面板
lib/bluez.js            BlueZ D-Bus 客户端（dbus-next）
lib/atvv.js             ATVV 协议状态机
lib/adpcm.js            IMA/DVI ADPCM 解码 + 帧切分
lib/devices.js          profile 匹配 + 系统探测
lib/keys.js             evdev 辅助进程管理
lib/evdev_helper.py     独占输入设备 + 虚拟键盘转发（Python 标准库）
profiles/*.json         设备 profile
test/live-atvv.mjs      真机联调脚本（不经 DSH，直接录一段存 WAV）
```

## 已知限制

- **只支持 Linux**。macOS 需要 CoreBluetooth 适配器，Windows 需要 WinRT 适配器，
  同一套 `lib/atvv.js` 可以直接复用，只换传输层。
- **一次只连一台遥控器**。多台同名设备需要实例选择，暂未实现。
- **语音键的拦截依赖 udev 权限**。没有 `input` 组权限时按键会漏到桌面。
- **识别语言默认中文**。其余语言在配置里填 `language` 即可。

## License

MIT

## 致谢

协议细节参考了 [open-voice-bridge](https://github.com/nijez/open-voice-bridge)
对小米 ARN9 / RC003 的 macOS 实现，以及在 Linux 上验证出来的
「HID 插件会抢走语音通道」这条结论。
