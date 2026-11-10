/**
 * 真机联调脚本：不经过 DSH，直接用本插件的 lib 连一台 ATVV 遥控器，
 * 录一段语音存成 WAV，方便验证协议与解码是否正确。
 *
 * 用法：
 *   node test/live-atvv.mjs                    # 录到松开语音键或 6 秒上限
 *   node test/live-atvv.mjs --seconds 4        # 固定录 4 秒
 *   node test/live-atvv.mjs --address E8:55:40:B1:C6:1A
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AtvvSession, pcmToWav } from '../lib/atvv.js'
import { BlueZClient } from '../lib/bluez.js'
import { loadProfiles, parseInputDevices, matchProfile, inspectHidPlugin } from '../lib/devices.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTDIR = path.join(HERE, '..', 'out')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const fixedSeconds = Number(arg('seconds', '0'))
const wantAddress = arg('address', '')

const hid = inspectHidPlugin()
console.log(`HID 插件禁用: ${hid.disabled} (${hid.configPath} DisablePlugins=${hid.value})`)
if (!hid.disabled) {
  console.log('⚠️  BlueZ 的 HID host 插件仍在运行，设备会走厂商加密通道，ATVV 很可能收不到音频')
}

const client = new BlueZClient({ log: (m) => console.log(`[bluez] ${m}`) })
await client.connect()
const devices = await client.listDevices()
const inputs = parseInputDevices()
const profiles = loadProfiles()

console.log(`发现 ${devices.length} 台蓝牙设备，${profiles.length} 个 profile`)
let chosen = null
for (const device of devices) {
  if (wantAddress && device.address.toLowerCase() !== wantAddress.toLowerCase()) continue
  const model = await client.readModelNumber(device.path)
  const matched = matchProfile(device, inputs, profiles, model)
  console.log(`  ${device.address} ${device.name || device.alias} connected=${device.connected} ` +
    `-> profile=${matched.profile?.id ?? 'none'} score=${matched.score} event=${matched.inputDevice?.event ?? '-'}`)
  if (!chosen && matched.profile && matched.score > 0 && device.connected) chosen = { device, matched }
}

if (!chosen) {
  console.error('没有可用的 ATVV 设备')
  process.exit(1)
}

const voice = chosen.matched.profile.voice
console.log(`\n连接 ${chosen.device.address}，语音通道: ${voice.protocol} ${voice.codec} ${voice.sampleRate}Hz frame=${voice.frameSize}`)

const frames = { audio: 0, control: 0 }
const session = new AtvvSession({
  write: (bytes) => transport.write(bytes).catch((e) => console.error('写失败', e.message)),
  sampleRate: voice.sampleRate,
})
session.on('log', ({ message }) => console.log(`[atvv] ${message}`))
session.on('capabilities', (caps) => {
  console.log(`能力: version=0x${caps.version.toString(16)} codec=0x${caps.selectedCodec.toString(16)} frame=${caps.frameSize}`)
  session.openMicrophone()
})

let finished = false
const finish = (reason) => {
  if (finished) return
  finished = true
  const pcm = session.stopStream(reason)
  if (!pcm || pcm.length === 0) {
    console.log('没有收到音频')
    process.exit(2)
  }
  fs.mkdirSync(OUTDIR, { recursive: true })
  const file = path.join(OUTDIR, `live_${Date.now()}.wav`)
  fs.writeFileSync(file, pcmToWav(pcm, voice.sampleRate))
  console.log(`\n已保存 ${file}  ${(pcm.length / voice.sampleRate).toFixed(2)}s  audio帧=${frames.audio} control帧=${frames.control}`)
  transport.close().then(() => process.exit(0))
}

const transport = await client.openAtvv(chosen.device.path, voice, {
  onControl: (bytes) => { frames.control += 1; session.handleControl(bytes) },
  onAudio: (bytes) => {
    frames.audio += 1
    session.lastAudioAt = Date.now()
    session.handleAudio(bytes)
  },
})
session.requestCapabilities()

console.log('\n请按住遥控器语音键说话…')
if (fixedSeconds > 0) {
  setTimeout(() => finish('fixed-duration'), fixedSeconds * 1000)
} else {
  const timer = setInterval(() => {
    if (session.streaming && Date.now() - (session.lastAudioAt ?? 0) > 1500) {
      clearInterval(timer)
      finish('silence')
    }
  }, 300)
  setTimeout(() => { clearInterval(timer); finish('timeout') }, 20000)
}
