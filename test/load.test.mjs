/** 插件入口冒烟测试：不启用任何 DSH 服务，只验证 apply() 不炸、导出契约正确。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('host 导出契约', async () => {
  const mod = await import('../host.js')
  assert.equal(mod.name, 'bt-remote-voice')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.PLUGIN_VERSION, 'string')
})

test('apply() 在空 ctx 下安全返回 runtime', async () => {
  const mod = await import('../host.js')
  const injected = []
  const effects = []
  const ctx = {
    inject(names, fn) { injected.push(names) },
    effect(fn) { effects.push(fn) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const runtime = mod.apply(ctx, { autoConnect: false })
  assert.ok(runtime)
  assert.equal(typeof runtime.diagnose, 'function')
  assert.deepEqual(injected, [['speechToText'], ['webServer'], ['tools']])
  assert.equal(effects.length, 1)
  const diag = runtime.diagnose()
  assert.equal(diag.state, 'idle')
  assert.ok(diag.profiles.length >= 3)
  assert.ok(Array.isArray(diag.inputDevices))
  await runtime.disconnect()
})

test('diagnose 能给出 HID 插件建议', async () => {
  const mod = await import('../host.js')
  const ctx = { inject() {}, effect() {}, logger: { debug() {} } }
  const runtime = mod.apply(ctx, { autoConnect: false })
  const diag = runtime.diagnose()
  assert.equal(typeof diag.hidPlugin.disabled, 'boolean')
  if (!diag.hidPlugin.disabled) assert.ok(diag.suggestedFix)
  await runtime.disconnect()
})

test('版本号在 package.json / host.js / 市场条目之间一致', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.join(here, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const mod = await import('../host.js')
  assert.equal(mod.PLUGIN_VERSION, pkg.version)
  const marketPath = path.join(root, 'docs', 'MARKET-ENTRY.json')
  if (fs.existsSync(marketPath)) {
    const market = JSON.parse(fs.readFileSync(marketPath, 'utf8'))
    assert.equal(market.format, 1)
    const entry = market.plugins.find((p) => p.name === pkg.name)
    assert.ok(entry, '市场索引里要有本插件条目')
    const versions = entry.versions.map((v) => v.version)
    assert.ok(versions.includes(pkg.version), `市场索引版本 ${versions} 应包含 ${pkg.version}`)
  }
})

test('webServer 路由注册：6 条，且 state 返回诊断快照', async () => {
  const mod = await import('../host.js')
  const registered = []
  const injected = {}
  const ctx = {
    inject(names, fn) { injected[names[0]] = fn },
    effect() {},
    logger: { debug() {} },
  }
  mod.apply(ctx, { autoConnect: false })

  const scope = {
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
  injected.webServer(scope)
  assert.equal(registered.length, 6)
  const kinds = registered.map((r) => `${r.kind}:${r.path}`)
  assert.ok(kinds.some((k) => k === 'exact:/dsh-bt-remote-voice/state'))
  assert.ok(kinds.some((k) => k === 'exact:/dsh-bt-remote-voice/connect'))
  assert.ok(kinds.some((k) => k.startsWith('prefix:')))

  // 调用 state 处理器
  const stateRoute = registered.find((r) => r.path.endsWith('/state'))
  let payload = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(body) { payload = body },
  }
  await stateRoute.handler({}, res)
  const parsed = JSON.parse(payload)
  assert.equal(parsed.state, 'idle')
  assert.ok(parsed.profiles.length >= 3)
  assert.equal(typeof parsed.hidPlugin.disabled, 'boolean')
})

test('tools 注册：bt_remote_voice 的参数结构正确', async () => {
  const mod = await import('../host.js')
  const injected = {}
  const ctx = { inject(names, fn) { injected[names[0]] = fn }, effect() {}, logger: { debug() {} } }
  mod.apply(ctx, { autoConnect: false })
  let tool = null
  injected.tools({ tools: { register(t) { tool = t; return () => {} } } })
  assert.ok(tool)
  assert.equal(tool.name, 'bt_remote_voice')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.ok(tool.parameters.properties.action.enum.includes('status'))
  const status = await tool.handler({ action: 'status' })
  assert.equal(status.state, 'idle')
  const unknown = await tool.handler({ action: 'nope' })
  assert.equal(unknown.ok, false)
})
