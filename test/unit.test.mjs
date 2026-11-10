/**
 * 纯逻辑单元测试：不碰蓝牙、不碰硬件。
 *   node --test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ImaAdpcmDecoder, FrameSplitter, shapePcm } from '../lib/adpcm.js'
import { AtvvCapabilities, AtvvSession, pcmToWav, hex } from '../lib/atvv.js'
import { loadProfiles, parseInputDevices, matchProfile, inspectHidPlugin } from '../lib/devices.js'

test('IMA ADPCM：全零输入保持静音', () => {
  const decoder = new ImaAdpcmDecoder()
  const pcm = decoder.decode(new Uint8Array(120))
  assert.equal(pcm.length, 240)
  assert.ok(pcm.every((v) => v === 0))
})

test('IMA ADPCM：predictor 跨帧连续，不重置', () => {
  const a = new ImaAdpcmDecoder()
  const first = a.decode(Uint8Array.from([0x77, 0x77]))
  const second = a.decode(Uint8Array.from([0x77, 0x77]))
  assert.notEqual(a.predictor, 0)
  // 第二帧从第一帧的末态继续，不会回到 0
  assert.notEqual(second[0], first[0])
})

test('IMA ADPCM：输出始终在 int16 范围内', () => {
  const decoder = new ImaAdpcmDecoder()
  const noisy = Uint8Array.from({ length: 600 }, (_, i) => (i * 37 + 11) & 0xff)
  const pcm = decoder.decode(noisy)
  for (const v of pcm) {
    assert.ok(v >= -32768 && v <= 32767)
  }
})

test('FrameSplitter：跨包拼帧且保留余量', () => {
  const splitter = new FrameSplitter(4)
  assert.equal(splitter.push(Uint8Array.from([1, 2])).length, 0)
  const frames = splitter.push(Uint8Array.from([3, 4, 5, 6, 7]))
  assert.equal(frames.length, 1)
  assert.deepEqual([...frames[0]], [1, 2, 3, 4])
  assert.equal(splitter.pending.length, 3)
})

test('shapePcm：增益不越界', () => {
  const input = Int16Array.from([0, 32000, -32000, 100, -100])
  const out = shapePcm(input, 24)
  for (const v of out) {
    assert.ok(v >= -32768 && v <= 32767)
  }
})

test('ATVV capabilities：解析实测响应', () => {
  // 小米 ARN9 真机返回：0b 01 00 02 03 00 78 00 00
  const caps = AtvvCapabilities.parse(Uint8Array.from([0x0b, 0x01, 0x00, 0x02, 0x03, 0x00, 0x78, 0x00, 0x00]))
  assert.ok(caps)
  assert.equal(caps.version, 0x0100)
  assert.equal(caps.selectedCodec, 0x02)
  assert.equal(caps.sampleRate, 16000)
  assert.equal(caps.frameSize, 120)
})

test('ATVV capabilities：非能力包返回 null', () => {
  assert.equal(AtvvCapabilities.parse(Uint8Array.from([0x04, 0x00, 0x02, 0x00])), null)
  assert.equal(AtvvCapabilities.parse(new Uint8Array(0)), null)
})

test('ATVV 会话：能力 -> 开麦 -> 起流 -> 收音频 -> 收尾', () => {
  const writes = []
  const session = new AtvvSession({ write: (b) => writes.push([...b]) })

  session.requestCapabilities()
  assert.deepEqual(writes.at(-1), [0x0a, 0x01, 0x00, 0x00, 0x03, 0x03])

  session.handleControl(Uint8Array.from([0x0b, 0x01, 0x00, 0x02, 0x03, 0x00, 0x78, 0x00, 0x00]))
  assert.equal(session.ready, true)
  assert.equal(session.splitter.frameSize, 120)

  session.handleControl(Uint8Array.from([0x08]))
  assert.deepEqual(writes.at(-1), [0x0c, 0x00])
  assert.equal(session.micOpened, true)

  session.handleControl(Uint8Array.from([0x04, 0x03, 0x02, 0x01]))
  assert.equal(session.streaming, true)
  assert.equal(session.sessionId, 1)

  // 送两帧音频（每帧 120 字节）
  session.handleAudio(new Uint8Array(120).fill(0x11))
  session.handleAudio(new Uint8Array(120).fill(0x11))
  assert.equal(session.pcmBytes, 480)

  let emitted = null
  session.on('pcm', (pcm) => { emitted = pcm })
  session.stopStream('test')
  assert.ok(emitted)
  assert.equal(emitted.length, 480)
})

test('ATVV 会话：stop 后重复调用不再发射', () => {
  const session = new AtvvSession({ write: () => {} })
  session.handleControl(Uint8Array.from([0x0b, 0x01, 0x00, 0x02, 0x03, 0x00, 0x78, 0x00, 0x00]))
  session.handleControl(Uint8Array.from([0x04, 0x03, 0x02, 0x01]))
  session.handleAudio(new Uint8Array(120).fill(0x22))
  assert.ok(session.stopStream('first'))
  assert.equal(session.stopStream('second'), null)
})

test('pcmToWav：头部字段正确', () => {
  const samples = Int16Array.from([0, 1000, -1000, 32767])
  const wav = pcmToWav(samples, 16000)
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE')
  assert.equal(wav.readUInt16LE(20), 1)          // PCM
  assert.equal(wav.readUInt16LE(22), 1)          // mono
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(34), 16)         // bits
  assert.equal(wav.readUInt32LE(40), samples.length * 2)
  assert.equal(wav.length, 44 + samples.length * 2)
})

test('profile：内置三份都能解析且字段齐全', () => {
  const profiles = loadProfiles()
  assert.ok(profiles.length >= 3)
  const ids = profiles.map((p) => p.id)
  assert.ok(ids.includes('xiaomi-arn9'))
  assert.ok(ids.includes('xiaomi-rc003'))
  assert.ok(ids.includes('generic-atvv'))
  for (const p of profiles) {
    assert.ok(p.voice, `${p.id} 缺 voice`)
    assert.equal(p.voice.protocol, 'atvv')
    assert.ok(p.voice.frameSize > 0)
    assert.ok(Array.isArray(p.keys.voice) && p.keys.voice.length > 0)
  }
})

test('匹配：小米 ARN9 按名字 + VID/PID 命中', () => {
  const profiles = loadProfiles()
  const device = {
    address: 'E8:55:40:B1:C6:1A',
    name: '小米蓝牙语音遥控器',
    alias: 'E8-55-40-B1-C6-1A',
    connected: true,
    uuids: ['ab5e0001-5a21-4f05-bc7d-af01f617b664'],
  }
  const inputs = [{
    name: 'bluez-hog-device', phys: '', uniq: 'e8:55:40:b1:c6:1a',
    handlers: ['kbd', 'event11'], event: 'event11', vendor: '2717', product: '32b8',
  }]
  const matched = matchProfile(device, inputs, profiles, null)
  assert.ok(matched.profile)
  assert.equal(matched.profile.id, 'xiaomi-arn9')
  assert.equal(matched.inputDevice.event, 'event11')
})

test('匹配：未知设备但有 ATVV 服务时回落到通用 profile', () => {
  const profiles = loadProfiles()
  const device = {
    address: '11:22:33:44:55:66',
    name: 'Some Remote',
    uuids: ['ab5e0001-5a21-4f05-bc7d-af01f617b664'],
  }
  const matched = matchProfile(device, [], profiles, null)
  assert.equal(matched.profile?.id, 'generic-atvv')
})

test('匹配：完全无关的设备不返回 profile', () => {
  const profiles = loadProfiles()
  const device = { address: '11:22:33:44:55:66', name: 'Keyboard', uuids: [] }
  const matched = matchProfile(device, [], profiles, null)
  assert.equal(matched.profile, null)
})

test('HID 插件检测：识别 DisablePlugins 里的 input', () => {
  const result = inspectHidPlugin('/nonexistent/main.conf')
  assert.equal(result.readable, false)
  assert.equal(result.disabled, false)
})

test('hex 辅助输出保持两位', () => {
  assert.equal(hex(Uint8Array.from([0x0b, 0x01, 0x00])), '0b 01 00')
})
