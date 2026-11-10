# 架构

## 一句话

遥控器的麦克风 → BLE ATVV → IMA ADPCM → 16 kHz PCM → WAV → DSH 语音识别 → 文字。

## 分层

```
┌──────────────────────────────────────────────────────────────┐
│ client.js        设置面板：状态、连接、日志                    │
├──────────────────────────────────────────────────────────────┤
│ host.js          编排：设备发现 → 连接 → 会话 → 识别 → 广播事件 │
│                  HTTP 路由 /dsh-bt-remote-voice/*              │
│                  Agent 工具 bt_remote_voice                    │
├──────────────────────────────────────────────────────────────┤
│ lib/devices.js   profile 匹配 + 系统探测（/proc、main.conf）    │
│ lib/keys.js      evdev 辅助进程管理                            │
│ lib/bluez.js     BlueZ D-Bus：设备枚举、GATT 订阅、写特征       │
│ lib/atvv.js      ATVV 状态机：能力/开麦/起流/停流/同步          │
│ lib/adpcm.js     IMA ADPCM 解码 + 帧切分 + 平滑增益             │
├──────────────────────────────────────────────────────────────┤
│ lib/evdev_helper.py  独占输入设备（EVIOCGRAB）+ 虚拟键盘转发    │
├──────────────────────────────────────────────────────────────┤
│ profiles/*.json  设备事实：怎么认、语音参数、按键码             │
└──────────────────────────────────────────────────────────────┘
```

## 为什么这么分

### 协议与传输分离

`lib/atvv.js` 只依赖一个 `write(bytes)` 回调和两个入站方法，不 import 任何蓝牙库。
Linux 用 `lib/bluez.js` 注入，将来 macOS/Windows 换一个传输层即可复用同一套状态机
和同一套解码器。

### 设备事实进 JSON

代码里没有任何厂商名、MAC、按键码。`profiles/*.json` 描述「怎么认出这台设备、
它的语音通道参数、它的按键 code」。新增设备 = 加一个文件，不动代码。

匹配打分：`deviceInfoModel` 95 > 蓝牙名精确 90 > VID+PID 85 > 蓝牙名包含 70 >
服务 UUID 60 > 通用回落 40。

### Python 只做 ioctl

`EVIOCGRAB`（独占输入设备）和写 `/dev/uinput` 需要 ioctl。Node 做这两件事要原生
模块（node-gyp 编译），而目标是「装完就能用、不编译」。Python 标准库的 `fcntl`
直接搞定，代价是多一个解释器进程，用 JSON 行协议通信。

如果环境没有 python3，插件降级：语音照常可用，只是按键漏到桌面、确认键不转发。

## 一次语音的完整时序

```
按键按下
  evdev_helper: KEY_F5 value=1
  host:         session.openMicrophone()  -> TX 0C 00
设备:          control notify 04 03 02 01  (STREAM_START, codec=2, session=1)
host:          state -> listening, 起静默看门狗
设备:          audio notify 120B × N      (IMA ADPCM)
host:          FrameSplitter -> ImaAdpcmDecoder -> 累积 PCM
按键松开 / 静默 1.2s / 收到 00
host:          stopStream() -> shapePcm() -> pcmToWav()
host:          speechToText.resolve({audio, language}) -> transcribe(spec)
host:          emit 'transcript' -> 面板 / 输入框
```

## 状态机

```
idle ──connect──> connecting ──> ready ──按键──> listening ──收尾──> transcribing ──> ready
                     │             ↑                                                      │
                     └── error <───┴────────────────── 失败 <─────────────────────────────┘
```

## 关键实现细节

### PropertiesChanged 必须挂在 Properties 接口上

dbus-next 里监听 `org.bluez.GattCharacteristic1` 接口的 `PropertiesChanged` **不会
触发**，必须 `getInterface('org.freedesktop.DBus.Properties')` 再监听。踩过这个坑，
表现是「能力请求发出去了，但永远收不到 `0x0B`」。

### frameSize 来自能力协商，不写死

实测小米 ARN9 返回 `0x78 = 120`，但 State 机不假设这个值——`0x0B` 响应里带什么就用
什么。`FrameSplitter` 在能力到达后 `setFrameSize()`。

### ADPCM 的 predictor 跨帧连续

每帧重置会让波形出现周期性爆音。`ImaAdpcmDecoder` 把 `predictor` / `stepIndex` 存成
实例状态，整段语音连续解码；`0x0A` 同步消息到达时用设备给的初值覆盖。

### 静默看门狗

有的固件在按键松开时不发 `0x00`，音频直接断。`armSilenceWatch()` 在 1.2 秒
（可配 `silenceMs`）没有新音频时主动收尾。

## 安全边界

- 只读 `profiles/`、`/proc/bus/input/devices`、`/etc/bluetooth/main.conf`、BlueZ D-Bus
- 只写 `/dev/uinput` 和目标输入设备的 ioctl
- HTTP 路由只暴露状态与连接控制，不接受任意文件路径或命令
- 不联网（识别由 DSH 自己的语音 provider 完成）

## 演进方向

1. **macOS 适配**：`lib/transport-corebluetooth.js`，替换 `lib/bluez.js`，状态机复用
2. **Windows 适配**：WinRT `BluetoothLEDevice`，同上
3. **多设备**：当前只连一台；需要实例选择 UI 与 per-device 会话
4. **流式识别**：现在整段送识别；接流式 provider 可以做到边说边出字
5. **按键映射可配置**：现在 profile 写死，下一步进设置面板
