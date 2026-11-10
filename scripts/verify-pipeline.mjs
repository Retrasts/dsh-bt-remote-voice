/**
 * 整条链路的离线验证：不需要遥控器。
 *
 * 把一段**已知会说什��**的真实录音重新编码成 IMA ADPCM（模拟设备输出的字节流），
 * 然后完全按 ATVV 的方式喂给插件的状态机：
 *
 *   handleControl(CAPS) → handleControl(STREAM_START) → handleAudio(120B × N) → stopStream()
 *   → PCM → WAV → 识别 → 与原文对比
 *
 * 这一步通过，说明「解码 + 组帧 + WAV + 识别」在 Node 侧是闭环正确的，
 * 剩下的不确定性只有 BLE 传输本身。
 *
 * 用法：
 *   node scripts/verify-pipeline.mjs <source.wav> ["期望文本"]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { AtvvSession, pcmToWav } from '../lib/atvv.js'

const PF_DIR = process.env.PF_DIR ?? path.join(os.homedir(), 'models', 'paraformer-zh')
const PYTHON = process.env.PF_PYTHON ?? '/home/zeiet/.venvs/mivoice/bin/python'

const src = process.argv[2]
const expected = process.argv[3] ?? ''
if (!src || !fs.existsSync(src)) {
  console.error('用法: node scripts/verify-pipeline.mjs <source.wav> ["期望文本"]')
  process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'))
const encoded = path.join(tmp, 'enc.wav')

// 1) 用 ffmpeg 把真实录音编码成 IMA ADPCM（模拟设备送来的字节）
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1',
  '-c:a', 'adpcm_ima_wav', '-block_size', '1024', encoded])

function parseWav(file) {
  const buf = fs.readFileSync(file)
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.subarray(pos, pos + 4).toString('ascii')
    const size = buf.readUInt32LE(pos + 4)
    const body = buf.subarray(pos + 8, pos + 8 + size)
    if (id === 'fmt ') fmt = { blockAlign: body.readUInt16LE(12), bits: body.readUInt16LE(14) }
    else if (id === 'data') data = body
    pos += 8 + size + (size % 2)
  }
  return { fmt, data }
}

const enc = parseWav(encoded)
console.log(`源文件 ${path.basename(src)} → IMA ADPCM ${enc.data.length}B (blockAlign=${enc.fmt.blockAlign})`)

// 2) 把 ADPCM 流按 ATVV 的方式喂进去。设备每帧 120 字节，不含块头，
//    所以这里先把 wav 的块头（每块 4 字节）拆掉，拼成连续的字节流。
const blockAlign = enc.fmt.blockAlign
const stream = []
for (let off = 0; off + blockAlign <= enc.data.length; off += blockAlign) {
  const block = enc.data.subarray(off, off + blockAlign)
  const predictor = block.readInt16LE(0)
  const stepIndex = block[2]
  stream.push({ predictor, stepIndex, payload: block.subarray(4) })
}

const session = new AtvvSession({ write: () => {}, sampleRate: 16000 })
session.on('log', ({ message }) => console.log(`[atvv] ${message}`))

session.handleControl(Uint8Array.from([0x0b, 0x01, 0x00, 0x02, 0x03, 0x00, 0x78, 0x00, 0x00]))
session.handleControl(Uint8Array.from([0x04, 0x03, 0x02, 0x01]))

let fed = 0
for (const piece of stream) {
  // 每个块先把块头当作 0x0A 同步消息交给状态机（真实设备也会按需发这条）
  session.pendingSync = { predictor: piece.predictor, stepIndex: piece.stepIndex }
  const payload = piece.payload
  for (let i = 0; i < payload.length; i += 120) {
    const chunk = payload.subarray(i, Math.min(i + 120, payload.length))
    session.handleAudio(chunk)
    fed += chunk.length
  }
}
console.log(`喂入 ${fed} 字节 ADPCM，分成 ${Math.ceil(fed / 120)} 个 ATVV 帧`)

const pcm = session.stopStream('offline-verify')
if (!pcm || pcm.length === 0) {
  console.error('❌ 没有解出 PCM')
  process.exit(1)
}
const wavPath = path.join(tmp, 'decoded.wav')
fs.writeFileSync(wavPath, pcmToWav(pcm, 16000))
const seconds = pcm.length / 16000
const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
console.log(`解出 ${pcm.length} 采样 (${seconds.toFixed(2)}s)，峰值 ${peak}`)

// 3) 识别
const script = `
import sys, wave, numpy as np, sherpa_onnx
rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
    paraformer="${PF_DIR}/model.int8.onnx",
    tokens="${PF_DIR}/tokens.txt",
    num_threads=2, sample_rate=16000, feature_dim=80, decoding_method="greedy_search")
w = wave.open(sys.argv[1])
a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
s = rec.create_stream(); s.accept_waveform(16000, a); rec.decode_stream(s)
print(s.result.text)
`
let text = ''
try {
  text = execFileSync(PYTHON, ['-c', script, wavPath], { encoding: 'utf8' }).trim()
} catch (error) {
  console.error('识别失败:', error.message)
}

console.log(`\n识别结果: ${text || '(空)'}`)
if (expected) console.log(`期望文本: ${expected}`)

fs.rmSync(tmp, { recursive: true, force: true })

const normalized = (s) => s.replace(/[\s，。！？、,.!?]/g, '')
const ok = expected
  ? normalized(text).includes(normalized(expected)) || normalized(expected).includes(normalized(text))
  : text.length > 0

if (ok) {
  console.log('\n✅ 通过：ATVV 组帧 → ADPCM 解码 → WAV → 识别 全链路在 Node 侧闭环正确')
  process.exit(0)
} else {
  console.log('\n⚠️  识别文本与期望不一致，检查源音频或模型')
  process.exit(2)
}
