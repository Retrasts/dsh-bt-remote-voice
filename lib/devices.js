/**
 * 设备发现与 profile 匹配。
 *
 * 设计目标是「通用」：不把小米写死在代码里，而是把「怎么认出这台设备、它的语音
 * 通道长什么样、它的按键是哪些码」全部放进 profiles/*.json。新增一款遥控器时只加
 * 一个 JSON，不改代码。
 *
 * 匹配优先级：蓝牙名 / VID+PID / Device Information Model Number / 服务 UUID。
 * 命中越具体越优先，都不命中则回落到 generic-atvv（只要设备暴露 ATVV 服务）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PROFILES_DIR = path.join(HERE, '..', 'profiles')

/** 读取全部内置 profile。 */
export function loadProfiles(dir = PROFILES_DIR) {
  const profiles = []
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return profiles
  }
  for (const name of names.sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (raw && raw.id) profiles.push(raw)
    } catch {
      // 单个 profile 写坏不影响其它
    }
  }
  return profiles
}

/**
 * 解析 /proc/bus/input/devices，拿到本机所有输入设备（含 uniq MAC 与 event 节点）。
 * @returns {Array<{name: string, phys: string, uniq: string, handlers: string[], event: string|null, vendor: string, product: string}>}
 */
export function parseInputDevices(procPath = '/proc/bus/input/devices') {
  let text = ''
  try {
    text = fs.readFileSync(procPath, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue
    const entry = { name: '', phys: '', uniq: '', handlers: [], event: null, vendor: '', product: '' }
    for (const line of block.split('\n')) {
      if (line.startsWith('N: Name=')) entry.name = line.slice(9).replace(/"/g, '').trim()
      else if (line.startsWith('P: Phys=')) entry.phys = line.slice(8).trim()
      else if (line.startsWith('U: Uniq=')) entry.uniq = line.slice(8).trim().toLowerCase()
      else if (line.startsWith('H: Handlers=')) {
        entry.handlers = line.slice(12).trim().split(/\s+/)
        entry.event = entry.handlers.find((h) => /^event\d+$/.test(h)) ?? null
      } else if (line.startsWith('I: Bus=')) {
        const m = line.match(/Vendor=([0-9a-fA-F]+)\s+Product=([0-9a-fA-F]+)/)
        if (m) {
          entry.vendor = m[1].toLowerCase()
          entry.product = m[2].toLowerCase()
        }
      }
    }
    if (entry.name) out.push(entry)
  }
  return out
}

/** 蓝牙 MAC 归一化，用来把 BlueZ 设备和 evdev 设备对上。 */
function normMac(mac) {
  return String(mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '')
}

/**
 * 把一台 BlueZ 设备和本机输入设备串起来，再按 profile 匹配。
 * @param {object} device BlueZClient.listDevices() 的一项
 * @param {object[]} inputDevices parseInputDevices() 的结果
 * @param {object[]} profiles loadProfiles() 的结果
 * @param {string|null} modelNumber Device Information 的 0x2A24
 */
export function matchProfile(device, inputDevices, profiles, modelNumber = null) {
  const mac = normMac(device.address)
  const input = inputDevices.find((d) => normMac(d.uniq) === mac) ?? null
  const names = [device.name, device.alias].filter(Boolean)

  let best = null
  let bestScore = 0
  for (const profile of profiles) {
    let score = 0
    const match = profile.match ?? {}
    if (Array.isArray(match.bluetoothNames)) {
      for (const candidate of match.bluetoothNames) {
        if (names.some((n) => n === candidate)) { score = Math.max(score, 90); break }
        if (names.some((n) => n.includes(candidate) || candidate.includes(n))) { score = Math.max(score, 70) }
      }
    }
    if (match.hid && input) {
      const v = Number.parseInt(input.vendor, 16)
      const p = Number.parseInt(input.product, 16)
      if (v === match.hid.vendorId && p === match.hid.productId) score = Math.max(score, 85)
    }
    if (match.deviceInfoModel && modelNumber) {
      const wanted = Array.isArray(match.deviceInfoModel) ? match.deviceInfoModel : [match.deviceInfoModel]
      if (wanted.includes(modelNumber)) score = Math.max(score, 95)
    }
    if (Array.isArray(match.serviceUuids)) {
      const uuids = (device.uuids ?? []).map((u) => String(u).toLowerCase())
      for (const want of match.serviceUuids) {
        if (uuids.some((u) => u.toLowerCase() === want.toLowerCase())) score = Math.max(score, 60)
      }
    }
    if (profile.id === 'generic-atvv' && score === 0) {
      const uuids = (device.uuids ?? []).map((u) => String(u).toLowerCase())
      const hasAtvv = uuids.some((u) => u.startsWith('ab5e0001'))
      if (hasAtvv) score = 40
    }
    if (score > bestScore) {
      bestScore = score
      best = profile
    }
  }
  return {
    profile: best,
    score: bestScore,
    inputDevice: input,
    mac: device.address,
    modelNumber,
  }
}

/**
 * 检查 BlueZ 是否还挂着 HID host 插件。
 * 挂着的后果：设备把语音切到厂商加密通道，ATVV 收不到任何音频。
 * @returns {{disabled: boolean, value: string|null, configPath: string}}
 */
export function inspectHidPlugin(configPath = '/etc/bluetooth/main.conf') {
  let text = ''
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch {
    return { disabled: false, value: null, configPath, readable: false }
  }
  const m = text.match(/^\s*DisablePlugins\s*=\s*(.+)$/m)
  const value = m ? m[1].trim() : null
  const disabled = Boolean(value && value.split(/[\s,]+/).includes('input'))
  return { disabled, value, configPath, readable: true }
}

/** 只保留带 MAC 的蓝牙输入设备，用于面板展示。 */
export function bluetoothInputDevices(inputDevices) {
  return inputDevices.filter((d) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(d.uniq))
}
