/**
 * IMA/DVI ADPCM 解码器（IMA ADPCM 4 bit，mono）。
 *
 * ATVV 语音流用这套编码：每帧 N 字节压缩数据展开成 2N 个 16 bit 采样，
 * predictor 与 stepIndex **跨帧连续**，不能每帧重置——否则波形会出现周期性的
 * 爆音，识别率显著下降。
 *
 * 这段实现照 Android TV Voice Service / Apple ATVV 的规范写：
 *   step        = STEP_TABLE[stepIndex]
 *   difference  = step >> 3
 *   difference += (nibble & 1) ? step >> 2 : 0
 *   difference += (nibble & 2) ? step >> 1 : 0
 *   difference += (nibble & 4) ? step      : 0
 *   predictor  += (nibble & 8) ? -difference : difference
 *   stepIndex  += INDEX_TABLE[nibble & 7]
 * 两者都夹在合法范围内。
 */

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
  143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
  4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
  27086, 29794, 32767,
]

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8]

export class ImaAdpcmDecoder {
  constructor() {
    this.predictor = 0
    this.stepIndex = 0
  }

  reset(predictor = 0, stepIndex = 0) {
    this.predictor = clamp(predictor, -32768, 32767)
    this.stepIndex = clamp(stepIndex, 0, 88)
  }

  /** @param {Uint8Array} data 压缩数据 @returns {Int16Array} PCM 采样 */
  decode(data) {
    const out = new Int16Array(data.length * 2)
    let p = this.predictor
    let si = this.stepIndex
    let o = 0
    for (let i = 0; i < data.length; i += 1) {
      const byte = data[i]
      for (const nibble of [byte >> 4, byte & 0x0f]) {
        const step = STEP_TABLE[si]
        let diff = step >> 3
        if (nibble & 1) diff += step >> 2
        if (nibble & 2) diff += step >> 1
        if (nibble & 4) diff += step
        p += nibble & 8 ? -diff : diff
        if (p > 32767) p = 32767
        else if (p < -32768) p = -32768
        si += INDEX_TABLE[nibble & 7]
        if (si < 0) si = 0
        else if (si > 88) si = 88
        out[o] = p
        o += 1
      }
    }
    this.predictor = p
    this.stepIndex = si
    return out
  }
}

/**
 * 帧切分器：把连续到达的 notify 数据切成固定长度的帧。
 * 设备每帧长度由 ATVV capabilities 的 frameSize 给出（小米 ARN9/RC003 是 120）。
 */
export class FrameSplitter {
  constructor(frameSize) {
    this.frameSize = frameSize > 0 ? frameSize : 120
    this.pending = new Uint8Array(0)
  }

  setFrameSize(size) {
    if (size > 0) this.frameSize = size
  }

  reset() {
    this.pending = new Uint8Array(0)
  }

  /** @param {Uint8Array} chunk @returns {Uint8Array[]} 完整帧 */
  push(chunk) {
    const merged = new Uint8Array(this.pending.length + chunk.length)
    merged.set(this.pending, 0)
    merged.set(chunk, this.pending.length)
    const frames = []
    let offset = 0
    while (merged.length - offset >= this.frameSize) {
      frames.push(merged.subarray(offset, offset + this.frameSize))
      offset += this.frameSize
    }
    this.pending = merged.subarray(offset)
    return frames
  }
}

/**
 * 3 点平滑 + 增益。遥控器麦克风电平偏低，增益 3 dB 对识别率有实际帮助；
 * 平滑抑制 ADPCM 在高频段的量化噪声。
 */
export function shapePcm(samples, gainDb = 3) {
  const out = new Int16Array(samples.length)
  const gain = 10 ** (gainDb / 20)
  for (let i = 0; i < samples.length; i += 1) {
    let v = samples[i]
    if (i > 0 && i < samples.length - 1) {
      v = (samples[i - 1] + 2 * samples[i] + samples[i + 1]) >> 2
    }
    const scaled = Math.round(v * gain)
    out[i] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled
  }
  return out
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}
