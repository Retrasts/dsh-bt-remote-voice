/**
 * 按键通道：管理 evdev 辅助进程（lib/evdev_helper.py）。
 *
 * 为什么交给 Python：独占输入设备（EVIOCGRAB）和写 /dev/uinput 都需要 ioctl，
 * Node 侧要原生模块；Python 标准库直接就能做，插件本体保持零原生依赖。
 *
 * 这里只负责：起进程、发指令、把 JSON 行解析成事件。
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, 'evdev_helper.py')

export class KeyChannel extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.python] 解释器路径
   * @param {(msg: object) => void} [options.log]
   */
  /**
   * @param {object} options
   * @param {string|string[]} [options.python] 解释器命令；可用 "sudo python3" 提权
   * @param {(msg: object) => void} [options.log]
   */
  constructor({ python = 'python3', log = () => {} } = {}) {
    super()
    this.python = python
    this.log = log
    this.child = null
    this.buffer = ''
    this.ready = false
  }

  /**
   * 开始监听一个输入设备。
   * @param {object} options
   * @param {string} options.event 例如 "event11"
   * @param {number[]} options.voiceKeys 语音键 code 列表
   * @param {boolean} [options.forward] 是否把非语音键转发到虚拟键盘
   */
  start(options) {
    const { event, voiceKeys, forward = true } = options
    this.lastOptions = options
    this.stopping = false
    this.restartCount = 0
    this.stop(true)
    // 允许 "sudo python3" 这种带空格的命令；读 evdev / 写 uinput 需要相应权限
    const parts = Array.isArray(this.python) ? this.python : String(this.python).split(/\s+/).filter(Boolean)
    const [cmd, ...args] = parts.length ? parts : ['python3']
    this.child = spawn(cmd, [...args, '-u', HELPER], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this.log(`[evdev] ${text}`)
    })
    this.child.on('exit', (code, signal) => {
      this.ready = false
      this.emit('exit', { code, signal })
      // 设备节点重建、权限变化等情况下 helper 会主动退出；只要不是我们主动 stop 的，
      // 就按退避重启，避免 F5 漏到桌面。
      if (!this.stopping && this.lastOptions) {
        this.restartCount = (this.restartCount ?? 0) + 1
        const delay = Math.min(2000 * this.restartCount, 15000)
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          if (!this.stopping && this.lastOptions && !this.child) {
            this.log(`[evdev] helper 自动重启（第 ${this.restartCount} 次）`)
            this.start(this.lastOptions)
          }
        }, delay)
        if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref()
      }
    })
    this.child.on('error', (error) => this.emit('error', error))
    this.send({ cmd: 'grab', event, voiceKeys, forward })
  }

  send(message) {
    if (!this.child || this.child.killed) return false
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
      return true
    } catch {
      return false
    }
  }

  updateVoiceKeys(voiceKeys) {
    this.send({ cmd: 'set', voiceKeys })
  }

  onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    switch (message.ev) {
      case 'ready':
        this.ready = true
        this.log(`[evdev] ${message.event} (${message.name || '未知设备'}) grabbed=${message.grabbed}`)
        this.emit('ready', message)
        break
      case 'key':
        this.emit('key', message)
        break
      case 'forward':
        this.emit('forward', message)
        break
      case 'error':
        this.log(`[evdev] ${message.message}`)
        this.emit('error', new Error(message.message))
        break
      case 'stopped':
        this.ready = false
        this.emit('stopped')
        break
      default:
        break
    }
  }

  stop(intentional = true) {
    if (intentional) {
      this.stopping = true
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
      this.lastOptions = null
    }
    if (!this.child) return
    try {
      this.send({ cmd: 'stop' })
      this.child.stdin.end()
    } catch { /* ignore */ }
    const child = this.child
    this.child = null
    this.ready = false
    setTimeout(() => {
      if (!child.killed) {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }
    }, 500)
  }
}
