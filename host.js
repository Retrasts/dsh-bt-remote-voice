/**
 * dsh-bt-remote-voice —— 宿主半区。
 *
 * 把一台蓝牙语音遥控器变成 DSH 的语音输入：按住遥控器语音键说话，松手后语音
 * 直接变成文字进入输入框。语音走设备自己的麦克风（BLE ATVV），不依赖电脑麦克风。
 *
 * ## 职责边界
 * - 宿主半区（本文件）：BlueZ GATT / ATVV / ADPCM / 设备发现 / 按键通道 / DSH 语音识别 / HTTP 路由 / Agent 工具
 * - 客户端半区（client.js）：设置面板、状态显示、把识别结果填进输入框
 *
 * ## 通用性
 * 设备相关的全部事实（怎么认、语音通道参数、按键码）都在 profiles/*.json，
 * 代码里不写死任何厂商。新增遥控器 = 加一个 JSON。
 *
 * ## 已知平台约束（Linux）
 * 必须禁用 BlueZ 的 HID host 插件，否则设备会切到厂商私有加密语音通道：
 *   /etc/bluetooth/main.conf -> [General] DisablePlugins = input
 * 面板会检测并给出提示。
 */

import { EventEmitter } from 'node:events'

import { AtvvSession, pcmToWav, hex } from './lib/atvv.js'
import { BlueZClient } from './lib/bluez.js'
import { KeyChannel } from './lib/keys.js'
import {
  loadProfiles,
  parseInputDevices,
  matchProfile,
  inspectHidPlugin,
  bluetoothInputDevices,
  PROFILES_DIR,
} from './lib/devices.js'

export const name = 'bt-remote-voice'
export const PLUGIN_VERSION = '0.1.0'
const ROUTE_PREFIX = '/dsh-bt-remote-voice'

/** 默认配置；全部字段都能被 profile 覆盖，也能在面板里改。 */
const DEFAULT_CONFIG = {
  /** 自动连接：启动后探测到已知设备就连。 */
  autoConnect: true,
  /** 指定 MAC；留空则用第一台匹配到 profile 的设备。 */
  deviceAddress: '',
  /** 识别语言提示。 */
  language: 'zh',
  /** 指定 DSH 语音 provider；留空用 DSH 的默认选择。 */
  providerId: '',
  /** 按键是否转发到虚拟键盘（确认键当回车等）。 */
  forwardKeys: true,
  /** 语音键 code 覆盖；留空用 profile。 */
  voiceKeys: [],
  /** 音频静默多久自动收尾（毫秒）。 */
  silenceMs: 1200,
  /** 最短有效录音（毫秒），短于此不送识别。 */
  minSpeechMs: 300,
  /**
   * 按键辅助进程的启动命令。读 evdev、写 uinput 通常需要 input 组权限，
   * 没有权限时可以把这里设成 "sudo -n python3"（前提是 sudoers 允许免密）。
   */
  keyHelperCommand: 'python3',
  /**
   * 没有启用 DSH 的 speech-to-text 插件时的降级识别命令。
   * 命令会收到 WAV 文件路径作为最后一个参数，stdout 作为识别结果。
   * 例：python3 /path/to/paraformer-cli.py
   */
  externalAsrCommand: '',
  /** 连接失败后是否自动重试（设备超时断开、休眠唤醒等场景）。 */
  autoReconnect: true,
  /**
   * 是否由插件自己独占 evdev 并转发按键。
   * 如果已经用 systemd 用户服务（scripts/mi-remote-grab.py）常驻独占同一个设备，
   * 这里要设成 false，否则两个进程会抢 EVIOCGRAB，后启动的那个静默失效。
   */
  enableKeyChannel: true,
}

const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  READY: 'ready',
  LISTENING: 'listening',
  TRANSCRIBING: 'transcribing',
  ERROR: 'error',
}

export class BridgeRuntime extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super()
    this.log = log
    this.state = STATE.IDLE
    this.profiles = loadProfiles()
    this.bluez = null
    this.session = null
    this.channel = null
    this.transport = null
    this.profile = null
    this.device = null
    this.inputDevice = null
    this.lastError = ''
    this.lastTranscript = ''
    this.lastAudioSeconds = 0
    this.lastInferenceSeconds = 0
    this.transcribeCount = 0
    this.transcribeFailures = 0
    this.startedAt = 0
    this.silenceTimer = null
    this.logBuffer = []
    this.audioFrames = 0
  }

  note(level, message) {
    const entry = { at: Date.now(), level, message }
    this.logBuffer.push(entry)
    if (this.logBuffer.length > 200) this.logBuffer.shift()
    this.log(`[bt-remote-voice] ${message}`)
    this.emit('log', entry)
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }

  /** 诊断信息：面板与 Agent 工具共用。 */
  diagnose() {
    const inputs = parseInputDevices()
    const hid = inspectHidPlugin()
    return {
      version: PLUGIN_VERSION,
      state: this.state,
      profiles: this.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        vendor: p.vendor,
        hasAtvv: p.voice?.protocol === 'atvv',
      })),
      profilesDir: PROFILES_DIR,
      hidPlugin: hid,
      inputDevices: bluetoothInputDevices(inputs).map((d) => ({
        name: d.name,
        mac: d.uniq,
        event: d.event,
        vendor: d.vendor,
        product: d.product,
      })),
      device: this.device
        ? {
            address: this.device.address,
            name: this.device.name,
            connected: this.device.connected,
            profile: this.profile?.id ?? null,
          }
        : null,
      speech: (() => {
        // DSH 的语音识别服务是否已接入；false 时录音能跑但拿不到文字
        const base = {
          ready: Boolean(this.speechToText),
          provider: this.lastProviderId ?? null,
          lastInferenceSeconds: this.lastInferenceSeconds,
          providers: [],
          externalCommand: Boolean(this.externalAsrConfigured),
        }
        try {
          const snap = this.speechToText?.snapshot?.()
          if (snap && Array.isArray(snap.providers)) {
            base.providers = snap.providers.map((p) => ({
              id: String(p.id ?? ''),
              name: p.name ?? '',
              phase: p.preparation?.phase ?? 'unknown',
            }))
          }
        } catch { /* 服务不可探查时忽略 */ }
        return base
      })(),
      lastError: this.lastError,
      lastTranscript: this.lastTranscript,
      transcribeCount: this.transcribeCount,
      transcribeFailures: this.transcribeFailures,
      suggestedFix: hid.disabled
        ? null
        : '检测到 BlueZ 的 HID host 插件仍在运行。请在 /etc/bluetooth/main.conf 的 [General] 段加 DisablePlugins = input，然后重启蓝牙服务，否则遥控器语音会走厂商加密通道，本插件收不到音频。',
    }
  }

  /**
   * 先把明显无关的设备筛掉，再读 Model Number。
   * BlueZ 会缓存大量历史设备（实测 118 台），每台读一次 0x2A24 要一次 D-Bus 往返。
   */
  prefilter(devices, config, inputs = []) {
    const limit = config.scanLimit ?? 12
    if (config.deviceAddress) {
      return devices.filter((d) => d.address.toLowerCase() === config.deviceAddress.toLowerCase())
    }
    const names = (d) => [d.name, d.alias].filter(Boolean).map((s) => s.toLowerCase())
    const norm = (mac) => String(mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '')
    const hit = devices.filter((d) => {
      // 1) 蓝牙名能对上某个 profile
      const ns = names(d)
      if (ns.length > 0 && this.profiles.some((p) =>
        (p.match?.bluetoothNames ?? []).some((candidate) =>
          ns.some((n) => n.includes(candidate.toLowerCase()) || candidate.toLowerCase().includes(n))))) {
        return true
      }
      // 2) 名字对不上时（BlueZ 在 HID 插件禁用后常把名字退化成 MAC），
      //    用本机输入设备的 VID/PID 反查 profile
      const input = inputs.find((i) => norm(i.uniq) === norm(d.address))
      if (input) {
        const vendor = Number.parseInt(input.vendor, 16)
        const product = Number.parseInt(input.product, 16)
        return this.profiles.some((p) =>
          p.match?.hid && p.match.hid.vendorId === vendor && p.match.hid.productId === product)
      }
      return false
    })
    return hit.slice(0, limit)
  }

  /** 枚举 BlueZ 里能对上的设备。 */
  async scan(config) {
    const client = await this.ensureBluez()
    const all = await client.listDevices()
    const inputs = parseInputDevices()
    const devices = this.prefilter(all, config, inputs)
    const results = []
    for (const device of devices) {
      const model = await client.readModelNumber(device.path)
      const matched = matchProfile(device, inputs, this.profiles, model)
      results.push({
        address: device.address,
        name: device.name || device.alias,
        connected: device.connected,
        paired: device.paired,
        profile: matched.profile?.id ?? null,
        score: matched.score,
        event: matched.inputDevice?.event ?? null,
        model,
      })
    }
    return results
  }

  async ensureBluez() {
    if (this.bluez) return this.bluez
    const client = new BlueZClient({ log: (m) => this.note('debug', m) })
    await client.connect()
    this.bluez = client
    return client
  }

  /** 连接设备：发现 -> 匹配 profile -> 打开 ATVV + 按键通道。 */
  async connect(config) {
    this.setState(STATE.CONNECTING)
    try {
      const client = await this.ensureBluez()
      const all = await client.listDevices()
      const inputs = parseInputDevices()
      const devices = this.prefilter(all, config, inputs)
      this.note('debug', `BlueZ 共 ${all.length} 台，预筛后 ${devices.length} 台`)

      let chosen = null
      for (const device of devices) {
        const model = await client.readModelNumber(device.path)
        const matched = matchProfile(device, inputs, this.profiles, model)
        if (matched.profile && matched.score > 0) {
          chosen = { device, matched }
          break
        }
      }
      if (!chosen) throw new Error('没有找到匹配 profile 的蓝牙遥控器；先在系统里配对并连接它。')
      if (!chosen.device.connected) throw new Error(`设备 ${chosen.device.address} 未连接`)

      this.device = chosen.device
      this.profile = chosen.matched.profile
      this.inputDevice = chosen.matched.inputDevice
      this.note('info', `匹配到 ${this.profile.name?.zh ?? this.profile.id} (${chosen.device.address})`)

      const voice = this.profile.voice
      if (!voice || voice.protocol !== 'atvv') {
        throw new Error(`profile ${this.profile.id} 没有 ATVV 语音通道，本插件只处理 ATVV 设备`)
      }

      this.session = new AtvvSession({
        write: (bytes) => { this.transport.write(bytes).catch((e) => this.note('error', `写失败: ${e.message}`)) },
        sampleRate: voice.sampleRate ?? 16000,
      })
      this.session.on('log', ({ level, message }) => this.note(level, message))
      this.session.on('capabilities', () => {
        this.setState(STATE.READY)
        // 拿到能力就先把麦克风打开：不同固件对「谁先开口」的要求不一致，
        // 提前开麦能让按键时立刻有音频，成本只是一条 2 字节写命令。
        this.session.openMicrophone()
      })
      this.session.on('stream-start', () => {
        this.setState(STATE.LISTENING)
        this.armSilenceWatch(config.silenceMs)
      })
      this.session.on('pcm', (samples) => { this.handlePcm(samples, config) })
      this.session.on('stream-stop', () => {
        this.disarmSilenceWatch()
        // 收尾后回到 ready；如果这次录到了 PCM，handlePcm 会立刻把它推到 transcribing
        if (this.state === STATE.LISTENING) this.setState(STATE.READY)
      })

      this.transport = await client.openAtvv(chosen.device.path, voice, {
        onControl: (bytes) => {
          this.controlFrames = (this.controlFrames ?? 0) + 1
          this.session.handleControl(bytes)
        },
        onAudio: (bytes) => {
          this.session.lastAudioAt = Date.now()
          this.audioFrames = (this.audioFrames ?? 0) + 1
          if (this.audioFrames === 1) this.note('info', `收到首帧音频 ${bytes.length}B`)
          this.session.handleAudio(bytes)
        },
      })
      this.session.requestCapabilities()

      // 按键通道
      const voiceKeys = config.voiceKeys?.length ? config.voiceKeys : (this.profile.keys?.voice ?? [62, 63])
      if (this.inputDevice?.event && config.enableKeyChannel !== false) {
        this.channel = new KeyChannel({ python: config.keyHelperCommand ?? 'python3', log: (m) => this.note('debug', m) })
        this.channel.on('key', (msg) => {
          if (msg.voice !== true) return
          this.note('debug', `语音键 code=${msg.code} value=${msg.value}`)
          if (msg.value === 1) {
            this.session.openMicrophone()
          } else if (msg.value === 0 && this.session.streaming) {
            this.session.stopStream('key-release')
          }
        })
        this.channel.on('forward', (msg) => {
          if (msg.value === 1) this.note('debug', `转发按键 code=${msg.code}`)
        })
        this.channel.on('error', (error) => this.note('warn', error.message))
        this.channel.start({
          event: this.inputDevice.event,
          voiceKeys,
          forward: config.forwardKeys !== false,
        })
      } else if (config.enableKeyChannel === false) {
        this.note('info', '按键通道已关闭（由外部守护进程独占设备）')
      } else {
        this.note('warn', '没有找到遥控器的输入设备节点，按键通道未启用；语音仍可用')
      }

      this.lastError = ''
      this.setState(STATE.READY)
      this.startedAt = Date.now()
      this.retryCount = 0
      if (!this.heartbeat) {
        this.heartbeat = setInterval(() => {
          if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref()
          this.note('debug', `heartbeat state=${this.state} streaming=${this.session?.streaming ?? false} ` +
            `audioFrames=${this.audioFrames} controlFrames=${this.controlFrames ?? 0}`)
        }, 15000)
        if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref()
      }
      return { ok: true, profile: this.profile.id, address: this.device.address }
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      this.setState(STATE.ERROR)
      this.note('error', this.lastError)
      this.scheduleRetry(config)
      return { ok: false, error: this.lastError }
    }
  }

  /**
   * 连接失败后按退避重试。
   * 实测场景：机器休眠/遥控器超时断开后，BlueZ 里设备还挂着但 Name 为空，
   * 插件启动那一刻匹配不到 profile；等用户再次唤醒遥控器就好了。没有重试的话
   * 插件会一直停在 error，而这期间 F5 会漏到浏览器触发页面刷新。
   */
  scheduleRetry(config) {
    if (config.autoReconnect === false) return
    if (this.retryTimer) return
    this.retryCount = (this.retryCount ?? 0) + 1
    if (this.retryCount > 60) {
      this.note('warn', '自动重连已达上限（60 次），停止重试')
      return
    }
    const delay = Math.min(5000 * this.retryCount, 60_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.note('debug', `自动重连第 ${this.retryCount} 次`)
      this.connect(config).catch(() => {})
    }, delay)
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref()
  }

  armSilenceWatch(silenceMs) {
    this.disarmSilenceWatch()
    const limit = silenceMs ?? 1200
    this.silenceTimer = setInterval(() => {
      if (!this.session?.streaming) return
      if (Date.now() - (this.session.lastAudioAt ?? 0) > limit) {
        this.session.stopStream('silence')
        this.disarmSilenceWatch()
      }
    }, 300)
    if (typeof this.silenceTimer.unref === 'function') this.silenceTimer.unref()
  }

  disarmSilenceWatch() {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  /** PCM 到手：转 WAV 交给 DSH 语音识别。 */
  async handlePcm(samples, config) {
    const seconds = samples.length / (this.profile?.voice?.sampleRate ?? 16000)
    if (seconds * 1000 < (config.minSpeechMs ?? 300)) {
      this.note('debug', `录音过短（${seconds.toFixed(2)}s），跳过识别`)
      return
    }
    const wav = pcmToWav(samples, this.profile?.voice?.sampleRate ?? 16000)
    this.emit('audio', { wav, seconds })
    this.setState(STATE.TRANSCRIBING)
    try {
      const text = await this.transcribe(wav, config)
      this.lastTranscript = text
      this.lastAudioSeconds = seconds
      this.transcribeCount += 1
      this.setState(STATE.READY)
      this.emit('transcript', { text, seconds })
    } catch (error) {
      this.transcribeFailures += 1
      this.lastError = String(error?.message ?? error)
      this.setState(STATE.ERROR)
      this.note('error', `识别失败: ${this.lastError}`)
    }
  }

  /**
   * 识别一段 WAV。
   * 优先用 DSH 的 speechToText；没接入时退回 config.externalAsrCommand
   * （命令收到 wav 路径作为最后一个参数，stdout 输出文本）。
   */
  async transcribe(wavBytes, config) {
    if (!this.speechToText) {
      if (!config.externalAsrCommand) {
        throw new Error('DSH 语音识别服务未就绪，且未配置 externalAsrCommand。请在「设置 → 插件」启用 experimental speech-to-text，或配置外部识别命令。')
      }
      return this.transcribeExternally(wavBytes, config)
    }
    const request = {
      audio: new Uint8Array(wavBytes),
      language: config.language || 'zh',
    }
    if (config.providerId) request.providerId = config.providerId
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const spec = this.speechToText.resolve(request)
      const transcript = await this.speechToText.transcribe(spec, controller.signal)
      this.lastInferenceSeconds = transcript?.inferenceSeconds ?? 0
      this.lastProviderId = String(spec?.provider?.info?.id ?? spec?.provider?.id ?? '') || null
      return String(transcript?.text ?? '').trim()
    } catch (error) {
      // DSH 的本地识别 provider 没准备好（模型没下载）时，不要整条链路失败，
      // 退回 externalAsrCommand 至少能出字。
      if (config.externalAsrCommand) {
        this.note('warn', `DSH 识别不可用（${error?.message ?? error}），回退到外部命令`)
        return this.transcribeExternally(wavBytes, config)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** 外部识别命令：把 WAV 落到临时文件，执行命令，取 stdout。 */
  async transcribeExternally(wavBytes, config) {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { execFile } = await import('node:child_process')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-remote-voice-'))
    const file = path.join(dir, 'speech.wav')
    fs.writeFileSync(file, Buffer.from(wavBytes))
    const command = String(config.externalAsrCommand).trim()
    if (!command) throw new Error('externalAsrCommand 为空')
    const started = Date.now()
    const text = await new Promise((resolve, reject) => {
      // 走 sh -c 是为了让带空格/中文的路径能正常工作；只用本机配置文件里的命令，不接外部输入
      const shellLine = `${command} "${file.replace(/"/g, '\\"')}"`
      execFile('sh', ['-c', shellLine], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
        if (error) reject(new Error(`${error.message}${stderr ? `: ${String(stderr).trim()}` : ''}`))
        else resolve(String(stdout).trim())
      })
    })
    this.lastInferenceSeconds = (Date.now() - started) / 1000
    this.lastProviderId = 'external-command'
    return text
  }

  async disconnect() {
    this.disarmSilenceWatch()
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
    if (this.channel) {
      this.channel.stop()
      this.channel = null
    }
    if (this.transport) {
      try { await this.transport.close() } catch { /* ignore */ }
      this.transport = null
    }
    if (this.session) {
      try { this.session.stopStream('disconnect') } catch { /* ignore */ }
      this.session = null
    }
    this.setState(STATE.IDLE)
  }

  /** 手动触发一次开麦（面板上的按钮/Agent 工具用）。 */
  openMic() {
    if (!this.session) throw new Error('尚未连接设备')
    this.session.openMicrophone()
  }

  closeMic() {
    if (!this.session) return
    this.session.stopStream('manual')
  }
}

/**
 * 插件入口。Cordis 会在插件挂载时调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const runtime = new BridgeRuntime({ log: (m) => ctx.logger?.debug?.(m) })
  runtime.externalAsrConfigured = Boolean(config.externalAsrCommand)
  ctx.effect(() => () => { runtime.disconnect() })

  // 语音识别服务
  ctx.inject(['speechToText'], (scope) => {
    try {
      runtime.speechToText = scope.speechToText
      runtime.note('info', '已接入 DSH 语音识别服务')
    } catch (error) {
      runtime.note('warn', `语音服务接入失败: ${error?.message ?? error}`)
    }
  })

  // HTTP 路由（面板与外部共用）
  ctx.inject(['webServer'], (scope) => {
    try {
      registerRoutes(ctx, scope, runtime, config)
    } catch (error) {
      runtime.note('warn', `HTTP 路由注册失败: ${error?.message ?? error}`)
    }
  })

  ctx.inject(['tools'], (scope) => {
    try {
      registerTools(ctx, scope, runtime, config)
    } catch (error) {
      runtime.note('warn', `工具注册失败: ${error?.message ?? error}`)
    }
  })

  if (config.autoConnect) {
    const timer = setTimeout(() => {
      runtime.connect(config).catch((error) => runtime.note('warn', `自动连接失败: ${error?.message ?? error}`))
    }, 1500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return runtime
}

function registerRoutes(ctx, scope, runtime, config) {
    const send = (res, code, body) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }
    const readBody = (req) => new Promise((resolve, reject) => {
      let chunks = ''
      req.on('data', (c) => { chunks += c; if (chunks.length > 1e6) reject(new Error('body too large')) })
      req.on('end', () => {
        try { resolve(chunks ? JSON.parse(chunks) : {}) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })
    const routes = [
      ['exact', `${ROUTE_PREFIX}/state`, async (req, res) => send(res, 200, runtime.diagnose())],
      ['exact', `${ROUTE_PREFIX}/scan`, async (req, res) => send(res, 200, { devices: await runtime.scan(config) })],
      ['exact', `${ROUTE_PREFIX}/connect`, async (req, res) => {
        const body = await readBody(req)
        send(res, 200, await runtime.connect({ ...config, ...body }))
      }],
      ['exact', `${ROUTE_PREFIX}/disconnect`, async (req, res) => {
        await runtime.disconnect()
        send(res, 200, { ok: true })
      }],
      ['exact', `${ROUTE_PREFIX}/log`, async (req, res) => send(res, 200, { log: runtime.logBuffer })],
      ['prefix', `${ROUTE_PREFIX}/`, async (req, res) => send(res, 404, { ok: false, error: 'not found' })],
    ]
    for (const [kind, path, handler] of routes) {
      let dispose = null
      try {
        dispose = scope.webServer.register({
          kind,
          path,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (error) {
              if (!res.headersSent) send(res, 500, { ok: false, error: String(error?.message ?? error) })
              else res.end()
            }
          },
        })
      } catch (error) {
        runtime.note('warn', `注册路由 ${path} 失败: ${error.message}`)
      }
      if (dispose) ctx.effect(() => () => { try { dispose() } catch { /* ignore */ } })
    }
}

function registerTools(ctx, scope, runtime, config) {
    try {
      const dispose = scope.tools.register({
        name: 'bt_remote_voice',
        description:
          'Inspect and control the DSH Bluetooth remote voice bridge (ATVV voice input from a BLE remote). ' +
          'Actions: status | scan | connect | disconnect | open_mic | close_mic | recent_log.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'scan', 'connect', 'disconnect', 'open_mic', 'close_mic', 'recent_log'],
            },
            address: { type: 'string', description: 'Bluetooth MAC for connect.' },
          },
          required: ['action'],
        },
        handler: async ({ action, address }) => {
          switch (action) {
            case 'status': return runtime.diagnose()
            case 'scan': return { devices: await runtime.scan(config) }
            case 'connect': return runtime.connect({ ...config, deviceAddress: address || config.deviceAddress })
            case 'disconnect': await runtime.disconnect(); return { ok: true }
            case 'open_mic': runtime.openMic(); return { ok: true }
            case 'close_mic': runtime.closeMic(); return { ok: true }
            case 'recent_log': return { log: runtime.logBuffer.slice(-40) }
            default: return { ok: false, error: `unknown action ${action}` }
          }
        },
      })
      if (dispose) ctx.effect(() => () => { try { dispose() } catch { /* ignore */ } })
    } catch (error) {
      runtime.note('warn', `注册工具失败: ${error.message}`)
    }
}
