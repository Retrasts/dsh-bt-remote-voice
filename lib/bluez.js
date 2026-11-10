/**
 * BlueZ 侧的最小 GATT 客户端（基于 D-Bus，dbus-next）。
 *
 * 只覆盖 ATVV 需要的动作：找到设备、按 UUID 找到三个特征、订阅 notify、
 * 写 without-response。避免引入完整 BLE 协议栈，也不编译任何原生模块。
 *
 * 重要前提：Linux 上必须先禁用 BlueZ 的 HID host 插件
 *   /etc/bluetooth/main.conf -> [General] DisablePlugins = input
 * 否则设备一挂成 HID 键盘就会把语音切到厂商私有加密通道，ATVV 收不到音频。
 */

import dbus from 'dbus-next'

const BLUEZ = 'org.bluez'
const IFACE_DEVICE = 'org.bluez.Device1'
const IFACE_CHR = 'org.bluez.GattCharacteristic1'
const IFACE_ADAPTER = 'org.bluez.Adapter1'
const IFACE_OBJMANAGER = 'org.freedesktop.DBus.ObjectManager'
const IFACE_PROPS = 'org.freedesktop.DBus.Properties'

/** BlueZ 的 MAC 表示法：E8:55:40:B1:C6:1A -> dev_E8_55_40_B1_C6_1A */
export function macToPath(mac) {
  return `dev_${mac.replace(/:/g, '_').toUpperCase()}`
}

/** 把 dbus-next 的 Variant/Array 值转成普通 Uint8Array。 */
export function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (value && typeof value === 'object' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array(0)
}

/** 解包 dbus-next 的 Variant（老版本 API）。 */
function unwrap(value) {
  return value && typeof value === 'object' && 'value' in value && value.signature !== undefined
    ? value.value
    : value
}

export class BlueZClient {
  constructor({ bus = null, adapter = null, log = () => {} } = {}) {
    this.bus = bus
    this.adapter = adapter
    this.log = log
    this.owned = bus === null
  }

  async connect() {
    if (!this.bus) {
      this.bus = dbus.systemBus()
      this.owned = true
    }
    if (!this.adapter) {
      const manager = await this.bus.getProxyObject(BLUEZ, '/')
      const om = manager.getInterface(IFACE_OBJMANAGER)
      const objects = await om.GetManagedObjects()
      for (const [path, ifaces] of Object.entries(objects)) {
        if (IFACE_ADAPTER in ifaces) {
          this.adapter = path
          break
        }
      }
    }
    if (!this.adapter) throw new Error('找不到可用的蓝牙适配器（org.bluez.Adapter1）')
    this.log(`adapter ${this.adapter}`)
    return this
  }

  async listDevices() {
    const manager = await this.bus.getProxyObject(BLUEZ, '/')
    const om = manager.getInterface(IFACE_OBJMANAGER)
    const objects = await om.GetManagedObjects()
    const devices = []
    for (const [path, ifaces] of Object.entries(objects)) {
      if (!(IFACE_DEVICE in ifaces)) continue
      const props = ifaces[IFACE_DEVICE]
      devices.push({
        path,
        address: unwrap(props.Address),
        name: unwrap(props.Name) ?? unwrap(props.Alias) ?? '',
        alias: unwrap(props.Alias) ?? '',
        connected: Boolean(unwrap(props.Connected)),
        paired: Boolean(unwrap(props.Paired)),
        trusted: Boolean(unwrap(props.Trusted)),
        uuids: (unwrap(props.UUIDs) ?? []).map(String),
        vendorId: unwrap(props.Modalias) ?? '',
      })
    }
    return devices
  }

  /**
   * 找到指定设备的 model number（Device Information Service 0x2A24），用来区分 RC003/ARN9。
   * 带超时：BlueZ 里可能缓存着大量历史设备，对不可达的设备读特征会一直等。
   */
  async readModelNumber(devicePath, timeoutMs = 1500) {
    const work = this.readModelNumberInner(devicePath)
    let timer = null
    try {
      return await Promise.race([
        work,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async readModelNumberInner(devicePath) {
    try {
      const root = await this.bus.getProxyObject(BLUEZ, '/')
      const om = root.getInterface(IFACE_OBJMANAGER)
      const objects = await om.GetManagedObjects()
      for (const [path, ifaces] of Object.entries(objects)) {
        if (!path.startsWith(devicePath)) continue
        const chr = ifaces[IFACE_CHR]
        if (!chr) continue
        if (unwrap(chr.UUID) !== '00002a24-0000-1000-8000-00805f9b34fb') continue
        const obj = await this.bus.getProxyObject(BLUEZ, path)
        const iface = obj.getInterface(IFACE_CHR)
        const value = await iface.ReadValue({})
        return Buffer.from(toBytes(value)).toString('ascii').replace(/\0/g, '').trim()
      }
    } catch (error) {
      this.log(`读 Model Number 失败: ${error.message}`)
    }
    return null
  }

  /**
   * 打开一条 ATVV 语音通道。
   * @param {string} devicePath BlueZ 设备对象路径
   * @param {object} voice profile 里的 voice 段
   * @param {(bytes: Uint8Array) => void} onControl
   * @param {(bytes: Uint8Array) => void} onAudio
   */
  async openAtvv(devicePath, voice, { onControl, onAudio }) {
    const root = await this.bus.getProxyObject(BLUEZ, '/')
    const om = root.getInterface(IFACE_OBJMANAGER)
    const objects = await om.GetManagedObjects()

    const wanted = {
      [voice.transmitUuid.toLowerCase()]: 'transmit',
      [voice.audioUuid.toLowerCase()]: 'audio',
      [voice.controlUuid.toLowerCase()]: 'control',
    }
    const found = {}

    for (const [path, ifaces] of Object.entries(objects)) {
      if (!path.startsWith(devicePath)) continue
      const chr = ifaces[IFACE_CHR]
      if (!chr) continue
      const uuid = String(unwrap(chr.UUID) ?? '').toLowerCase()
      const role = wanted[uuid]
      if (role && !found[role]) found[role] = path
    }

    for (const role of ['transmit', 'audio', 'control']) {
      if (!found[role]) throw new Error(`设备缺少 ATVV ${role} 特征（${voice[`${role}Uuid`]}）`)
    }

    const open = async (path) => {
      const obj = await this.bus.getProxyObject(BLUEZ, path)
      return obj.getInterface(IFACE_CHR)
    }

    const transmit = await open(found.transmit)
    const audio = await open(found.audio)
    const control = await open(found.control)

    // 注意：必须监听 org.freedesktop.DBus.Properties 的 PropertiesChanged，
    // 不能监听 GattCharacteristic1 接口上的同名事件——后者在 dbus-next 里不会触发。
    const watch = async (charPath, handler, label) => {
      const obj = await this.bus.getProxyObject(BLUEZ, charPath)
      const props = obj.getInterface(IFACE_PROPS)
      props.on('PropertiesChanged', (ifaceName, changed) => {
        if (ifaceName !== IFACE_CHR || !changed) return
        const raw = changed.Value ?? changed.value
        if (raw === undefined) return
        const bytes = toBytes(unwrap(raw))
        if (bytes.length === 0) return
        handler(bytes, label)
      })
    }

    await watch(found.audio, onAudio, 'audio')
    await watch(found.control, onControl, 'control')
    await audio.StartNotify()
    await control.StartNotify()
    this.log('ATVV notify 已订阅')

    return {
      write: async (bytes) => {
        await transmit.WriteValue(Array.from(bytes), {})
      },
      close: async () => {
        try { await audio.StopNotify() } catch { /* 设备可能已断开 */ }
        try { await control.StopNotify() } catch { /* 同上 */ }
      },
    }
  }

  async disconnect() {
    try {
      if (this.bus && this.owned) this.bus.disconnect()
    } catch { /* ignore */ }
  }
}
