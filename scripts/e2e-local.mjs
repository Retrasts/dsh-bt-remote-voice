/**
 * 端到端本机验证：用真实的 BlueZ + 真实的 BridgeRuntime，但把 DSH 的
 * speechToText 换成一个本地 Paraformer 适配器，这样不用重启 DSH 也能验证
 * 「按键 → ATVV 音频 → ADPCM → WAV → 识别」整条链路。
 *
 * 用法：
 *   node scripts/e2e-local.mjs                 # 等按键，30 秒窗口
 *   node scripts/e2e-local.mjs --seconds 60
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { BridgeRuntime } from '../host.js'

const PF_DIR = process.env.PF_DIR ?? path.join(os.homedir(), 'models', 'paraformer-zh')
const OUTDIR = path.join(process.cwd(), 'out')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const seconds = Number(arg('seconds', '30'))

/**
 * 把 DSH 的 speechToText 服务换成本地 Paraformer。
 * resolve() 只做参数校验，transcribe() 真正读 WAV 并调 Python。
 */
function createLocalSpeech() {
  return {
    resolve(request) {
      if (!request?.audio || request.audio.length === 0) throw new Error('audio 为空')
      return { audio: request.audio, language: request.language ?? 'zh', provider: { id: 'local-paraformer' } }
    },
    async transcribe(spec) {
      fs.mkdirSync(OUTDIR, { recursive: true })
      const wavPath = path.join(OUTDIR, `e2e_${Date.now()}.wav`)
      fs.writeFileSync(wavPath, Buffer.from(spec.audio))
      const started = Date.now()
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
      const text = execFileSync('/home/zeiet/.venvs/mivoice/bin/python', ['-c', script, wavPath], {
        encoding: 'utf8',
      }).trim()
      const inferenceSeconds = (Date.now() - started) / 1000
      const audioSeconds = spec.audio.length / 32000
      return { text, audioSeconds, inferenceSeconds }
    },
  }
}

const runtime = new BridgeRuntime({ log: (m) => console.log(m) })
runtime.speechToText = createLocalSpeech()

runtime.on('state', (s) => console.log(`[state] ${s}`))
runtime.on('transcript', ({ text, seconds: dur }) => {
  console.log(`\n>>> 识别结果 (${dur.toFixed(2)}s): ${text}\n`)
  runtime.disconnect().then(() => process.exit(0))
})
runtime.on('audio', ({ seconds: dur }) => console.log(`[audio] ${dur.toFixed(2)}s PCM 已就绪`))

console.log('=== 本地端到端验证 ===')
console.log(`Paraformer: ${PF_DIR}`)
console.log('检查 HID 插件状态…')
const diag = runtime.diagnose()
console.log(`HID 插件禁用: ${diag.hidPlugin.disabled}`)
if (!diag.hidPlugin.disabled) console.log(`⚠️  ${diag.suggestedFix}`)

const config = {
  autoConnect: true,
  deviceAddress: arg('address', 'E8:55:40:B1:C6:1A'),
  language: 'zh',
  providerId: '',
  forwardKeys: false,
  voiceKeys: [],
  silenceMs: 1200,
  minSpeechMs: 300,
  // 本机 evdev 是 root:input 660，普通用户读不到；用免密 sudo 起辅助进程，
  // 这样按键通道（F5 拦截、确认键转发）也能在联调里一起验证。
  keyHelperCommand: 'sudo -n python3',
}

const result = await runtime.connect(config)
if (!result.ok) {
  console.error('连接失败:', result.error)
  process.exit(1)
}
console.log(`\n已连接 profile=${result.profile} ${result.address}`)
console.log(`现在有 ${seconds} 秒：请按住遥控器语音键，说一句话，然后松开。\n`)

setTimeout(async () => {
  console.log('窗口结束，没有收到音频')
  await runtime.disconnect()
  process.exit(2)
}, seconds * 1000)
