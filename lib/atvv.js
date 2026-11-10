/**
 * ATVV（Android TV Voice over BLE）协议状态机。
 *
 * 只做协议，不碰传输：写命令走构造时注入的 `write(bytes)` 回调，收到的
 * notify 走 `handleControl()` / `handleAudio()`。这样同一套状态机能挂在
 * BlueZ D-Bus（Linux）、CoreBluetooth（macOS）或 WinRT（Windows）上。
 *
 * 端点（小米 ARN9 / RC003 实测一致）：
 *   Service  AB5E0001-5A21-4F05-BC7D-AF01F617B664
 *   Transmit AB5E0002  write           主机 -> 遥控器
 *   Audio    AB5E0003  notify          遥控器 -> 主机（IMA ADPCM 帧）
 *   Control  AB5E0004  notify          遥控器 -> 主机（能力/开麦/起流/停止/同步）
 *
 * 控制消息：
 *   0x0B  capabilities     响应，后面跟 version/codec/frameSize
 *   0x08  mic open 请求    主机应回 0x0C
 *   0x04  stream start     主机开始收音频
 *   0x00  stream stop      主机收尾
 *   0x0A  同步             带 predictor 与 stepIndex
 */

import { EventEmitter } from 'node:events'
import { ImaAdpcmDecoder, FrameSplitter, shapePcm } from './adpcm.js'

export const ATVV = {
  service: 'ab5e0001-5a21-4f05-bc7d-af01f617b664',
  transmit: 'ab5e0002-5a21-4f05-bc7d-af01f617b664',
  audio: 'ab5e0003-5a21-4f05-bc7d-af01f617b664',
  control: 'ab5e0004-5a21-4f05-bc7d-af01f617b664',
}

/** GET_CAPABILITIES（v1.0）：0A 01 00 00 03 03 */
export const GET_CAPABILITIES = Uint8Array.from([0x0a, 0x01, 0x00, 0x00, 0x03, 0x03])

export class AtvvCapabilities {
  constructor({ version, codecs, interaction, frameSize, selectedCodec, sampleRate }) {
    this.version = version
    this.codecs = codecs
    this.interaction = interaction
    this.frameSize = frameSize
    this.selectedCodec = selectedCodec
    this.sampleRate = sampleRate
  }

  static parse(bytes) {
    if (!bytes || bytes.length < 7 || bytes[0] !== 0x0b) return null
    const version = (bytes[1] << 8) | bytes[2]
    let codecs
    let interaction
    if (version >= 0x0100) {
      codecs = bytes[3]
      interaction = bytes[4]
      if (codecs === 0 && bytes.length >= 9 && (bytes[4] & 0x03) !== 0) {
        codecs = bytes[4]
        interaction = 0x03
      }
    } else {
      if (bytes.length < 9) return null
      codecs = bytes[4]
      interaction = 0
    }
    const frameSize = (bytes[5] << 8) | bytes[6]
    const selectedCodec = codecs & 0x02 ? 0x02 : 0x01
    return new AtvvCapabilities({
      version,
      codecs,
      interaction,
      frameSize: frameSize === 0 ? 120 : frameSize,
      selectedCodec,
      sampleRate: selectedCodec === 0x02 ? 16000 : 8000,
    })
  }
}

/**
 * 一次语音会话。
 * 事件：
 *   'capabilities' (caps)
 *   'stream-start' ({ sessionId, codec })
 *   'stream-stop'  ({ reason })
 *   'pcm'          (Int16Array) 一段可用的 16 kHz PCM
 *   'log'          ({ level, message })
 */
export class AtvvSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {(bytes: Uint8Array) => void} options.write 写 Transmit 特征
   * @param {number} [options.sampleRate]
   */
  constructor({ write, sampleRate = 16000 }) {
    super()
    this.write = write
    this.sampleRate = sampleRate
    this.caps = null
    this.decoder = new ImaAdpcmDecoder()
    this.splitter = new FrameSplitter(120)
    this.streaming = false
    this.micOpened = false
    this.sessionId = 0
    this.pendingSync = null
    this.pcmBuffer = []
    this.pcmBytes = 0
  }

  get ready() {
    return this.caps !== null
  }

  log(message, level = 'info') {
    this.emit('log', { level, message })
  }

  /** 主机主动询问能力。 */
  requestCapabilities() {
    this.write(GET_CAPABILITIES)
    this.log('TX GET_CAPABILITIES')
  }

  /** 开麦：版本 >= 1.0 只发 0C 00，旧版要带 codec。 */
  openMicrophone() {
    if (this.micOpened || !this.caps) return
    const cmd = this.caps.version >= 0x0100
      ? Uint8Array.from([0x0c, 0x00])
      : Uint8Array.from([0x0c, 0x00, this.caps.selectedCodec])
    this.write(cmd)
    this.micOpened = true
    this.log(`TX MIC_OPEN ${[...cmd].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
  }

  /** 关麦。 */
  closeMicrophone() {
    if (!this.micOpened || !this.caps) return
    const cmd = this.caps.version >= 0x0100
      ? Uint8Array.from([0x0d, this.sessionId])
      : Uint8Array.from([0x0d])
    this.write(cmd)
    this.micOpened = false
    this.log('TX MIC_CLOSE')
  }

  handleControl(bytes) {
    if (!bytes || bytes.length === 0) return
    const op = bytes[0]
    switch (op) {
      case 0x0b: {
        const caps = AtvvCapabilities.parse(bytes)
        if (!caps) {
          this.log('无效 capabilities 响应', 'warn')
          return
        }
        this.caps = caps
        this.splitter.setFrameSize(caps.frameSize)
        this.log(
          `CAPS version=0x${caps.version.toString(16).padStart(4, '0')} ` +
          `codec=0x${caps.selectedCodec.toString(16).padStart(2, '0')} ` +
          `frame=${caps.frameSize} rate=${caps.sampleRate}`,
        )
        this.emit('capabilities', caps)
        break
      }
      case 0x08:
        this.log('RCV MIC_OPEN 请求')
        this.openMicrophone()
        break
      case 0x04: {
        if (bytes.length >= 3) {
          const codec = bytes[2]
          this.sessionId = bytes.length >= 4 ? bytes[3] : 0
          if (this.caps) {
            this.caps.selectedCodec = codec
            this.caps.sampleRate = codec === 0x02 ? 16000 : 8000
          }
        }
        this.startStream()
        break
      }
      case 0x00:
        this.log('RCV STREAM_STOP')
        this.micOpened = false
        this.stopStream('control')
        break
      case 0x0a:
        if (bytes.length >= 7) {
          const predictor = ((bytes[4] << 8) | bytes[5]) << 16 >> 16
          this.pendingSync = { predictor, stepIndex: bytes[6] }
          this.log(`SYNC predictor=${predictor} step=${bytes[6]}`)
        }
        break
      default:
        this.log(`CTRL 0x${op.toString(16).padStart(2, '0')} ${hex(bytes)}`, 'debug')
    }
  }

  handleAudio(bytes) {
    if (!this.caps) return
    if (this.pendingSync) {
      this.decoder.reset(this.pendingSync.predictor, this.pendingSync.stepIndex)
      this.pendingSync = null
    }
    if (!this.streaming) this.startStream()
    for (const frame of this.splitter.push(bytes)) {
      const pcm = this.decoder.decode(frame)
      this.pcmBuffer.push(pcm)
      this.pcmBytes += pcm.length
    }
  }

  startStream() {
    this.decoder.reset(0, 0)
    this.splitter.reset()
    this.pcmBuffer = []
    this.pcmBytes = 0
    if (this.streaming) return
    this.streaming = true
    this.log(`STREAM_START session=${this.sessionId}`)
    this.emit('stream-start', { sessionId: this.sessionId, codec: this.caps?.selectedCodec ?? null })
  }

  /** 收尾并把累积的 PCM 交出去。 */
  stopStream(reason = 'manual') {
    if (!this.streaming) return null
    this.streaming = false
    const total = this.pcmBuffer.reduce((n, chunk) => n + chunk.length, 0)
    const merged = new Int16Array(total)
    let offset = 0
    for (const chunk of this.pcmBuffer) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.pcmBuffer = []
    this.pcmBytes = 0
    this.splitter.reset()
    this.log(`STREAM_STOP reason=${reason} samples=${total} (${(total / this.sampleRate).toFixed(2)}s)`)
    this.emit('stream-stop', { reason, samples: total })
    if (total === 0) return null
    const shaped = shapePcm(merged)
    this.emit('pcm', shaped)
    return shaped
  }

  /** 没有控制帧但音频静默太久时，由外部看门狗调用。 */
  idleFor(ms, now = Date.now()) {
    return this.streaming && now - (this.lastAudioAt ?? 0) > ms
  }
}

export function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

/** Int16Array -> 16 bit mono WAV bytes */
export function pcmToWav(samples, sampleRate = 16000) {
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2)
  }
  return buffer
}
