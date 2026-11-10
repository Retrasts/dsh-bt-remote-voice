/**
 * dsh-bt-remote-voice —— 客户端半区。
 *
 * 这里只做一件事：在「设置 → 插件」里给出一页状态面板，显示设备、profile、
 * HID 插件诊断、最近日志，并提供连接/断开按钮。
 *
 * 语音本身完全在宿主侧完成（遥控器麦克风 → BLE ATVV → ADPCM → DSH 语音识别），
 * 页面不参与录音，所以这一半很薄。
 */

window.__ModuleLoader__.load({
  id: 'dsh-bt-remote-voice',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const name = 'bt-remote-voice'
    const inject = ['slots']

    /** 与宿主半区一致的 HTTP 前缀 */
    const API = '/dsh-bt-remote-voice'
    const POLL_MS = 4000

    const STYLE_ID = 'dsh-bt-remote-voice/client.css'
    const CSS = `
.bv-root { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.bv-muted { color: var(--dsw-alias-label-caption); }
.bv-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 8px;
}
.bv-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bv-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); font-size: 11px;
}
.bv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-caption); }
.bv-dot.ok { background: #2ea043; }
.bv-dot.warn { background: #d29922; }
.bv-dot.err { background: #f85149; }
.bv-btn {
  border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: inherit; border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer;
}
.bv-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.bv-log { font-family: ui-monospace, monospace; font-size: 11px; max-height: 160px; overflow: auto; }
.bv-warn {
  border-left: 3px solid #d29922; padding: 6px 10px; margin-bottom: 8px;
  background: rgba(210,153,34,0.08); border-radius: 4px;
}
`

    function useStyles() {
      react.useEffect(() => {
        if (document.getElementById(STYLE_ID)) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    async function api(path, init) {
      const res = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.json()
    }

    function dotClass(state) {
      if (state === 'ready' || state === 'listening') return 'ok'
      if (state === 'connecting' || state === 'transcribing') return 'warn'
      if (state === 'error') return 'err'
      return ''
    }

    // ── 把识别结果送进 DSH 的输入框 ──────────────────────────────────────────
    // 宿主侧只负责「录到 PCM → 识别 → emit transcript」，落到光标处必须在页面侧做，
    // 而且受控输入框必须走原生 setter / execCommand 才能让 React 收到变化。

    function isVisible(el) {
      if (!el || el.offsetParent === null) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    function isTextEntry(el) {
      if (!el) return false
      if (el.tagName === 'TEXTAREA') return true
      if (el.tagName === 'INPUT') {
        const type = String(el.getAttribute('type') ?? 'text').toLowerCase()
        return ['text', 'search', 'url', 'email', 'password', 'tel'].includes(type)
      }
      return el.isContentEditable === true
    }

    /** 找当前会话输入框：优先焦点元素，其次视口下半部最宽的多行输入。 */
    function findComposer() {
      const active = document.activeElement
      if (isTextEntry(active) && isVisible(active)) return active
      const candidates = []
      for (const el of document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')) {
        if (!isTextEntry(el) || !isVisible(el)) continue
        const rect = el.getBoundingClientRect()
        let score = rect.width
        if (rect.top > window.innerHeight * 0.35) score += 2000
        if (el.tagName === 'TEXTAREA' || el.isContentEditable) score += 1000
        candidates.push({ el, score })
      }
      if (candidates.length === 0) return null
      candidates.sort((a, b) => b.score - a.score)
      return candidates[0].el
    }

    function insertTextInto(el, text) {
      if (!el || !text) return false
      el.focus()
      if (el.isContentEditable === true) {
        const selection = window.getSelection()
        if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
          if (document.execCommand('insertText', false, text)) return true
        }
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        if (selection) { selection.removeAllRanges(); selection.addRange(range) }
        if (document.execCommand('insertText', false, text)) return true
        el.textContent = `${el.textContent ?? ''}${text}`
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        return true
      }
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`
      if (typeof setter === 'function') setter.call(el, next)
      else el.value = next
      el.selectionStart = start + text.length
      el.selectionEnd = start + text.length
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    function Panel() {
      useStyles()
      const [state, setState] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')

      const refresh = react.useCallback(async () => {
        try {
          setState(await api('/state'))
          setError('')
        } catch (e) {
          setError(String(e.message ?? e))
        }
      }, [])

      react.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const run = async (path) => {
        setBusy(true)
        try {
          await api(path, { method: 'POST', body: '{}' })
          await refresh()
        } catch (e) {
          setError(String(e.message ?? e))
        } finally {
          setBusy(false)
        }
      }

      if (state === null) {
        return h('div', { className: 'bv-root bv-muted' }, error ? `状态读取失败：${error}` : '读取中…')
      }

      return h('div', { className: 'bv-root' },
        state.suggestedFix
          ? h('div', { className: 'bv-warn' }, state.suggestedFix)
          : null,
        h('div', { className: 'bv-card' },
          h('div', { className: 'bv-row' },
            h('span', { className: 'bv-pill' },
              h('span', { className: `bv-dot ${dotClass(state.state)}` }),
              state.state),
            h('span', { className: 'bv-muted' }, `v${state.version}`),
            h('span', { className: 'bv-muted' },
              state.hidPlugin?.disabled ? 'HID 插件已禁用（正确）' : 'HID 插件未禁用'),
          ),
          h('div', { className: 'bv-row', style: { marginTop: 8 } },
            h('span', { className: 'bv-muted' }, '设备：'),
            state.device
              ? h('span', null, `${state.device.name || '未命名'} (${state.device.address}) · ${state.device.profile ?? '未匹配 profile'}`)
              : h('span', { className: 'bv-muted' }, '未连接'),
          ),
          h('div', { className: 'bv-row', style: { marginTop: 8 } },
            h('button', { className: 'bv-btn', disabled: busy, onClick: () => run('/connect') }, '连接'),
            h('button', { className: 'bv-btn', disabled: busy, onClick: () => run('/disconnect') }, '断开'),
            h('button', { className: 'bv-btn', disabled: busy, onClick: refresh }, '刷新'),
          ),
        ),
        state.lastTranscript
          ? h('div', { className: 'bv-card' },
              h('div', { className: 'bv-muted' }, '最近一次识别'),
              h('div', null, state.lastTranscript))
          : null,
        h('div', { className: 'bv-card' },
          h('div', { className: 'bv-muted', style: { marginBottom: 4 } },
            `输入设备 ${state.inputDevices?.length ?? 0} 台 · profile ${state.profiles?.length ?? 0} 个`),
          h('div', { className: 'bv-log bv-muted' },
            (state.profiles ?? []).map((p) =>
              h('div', { key: p.id }, `${p.id} — ${p.name?.zh ?? p.name?.en ?? ''}`)),
          ),
        ),
      )
    }

    function apply(ctx) {
      // 独立于设置页的轮询：只要插件加载就监听新的识别结果并插入输入框
      let lastCount = -1
      let stopped = false
      const pollTimer = window.setInterval(async () => {
        if (stopped) return
        try {
          const state = await api('/state')
          const count = Number(state?.transcribeCount ?? 0)
          if (lastCount < 0) { lastCount = count; return }
          if (count > lastCount) {
            lastCount = count
            const text = String(state?.lastTranscript ?? '').trim()
            if (text) {
              const composer = findComposer()
              if (composer) insertTextInto(composer, text)
              else console.warn('[bt-remote-voice] 识别完成但没找到输入框:', text)
            }
          }
        } catch { /* 宿主暂时不可达时静默重试 */ }
      }, 1000)
      ctx.effect(() => () => {
        stopped = true
        window.clearInterval(pollTimer)
      })

      ctx.inject(['slots'], (scope) => {
        const slots = scope.get('slots')
        if (slots === undefined || slots === null) {
          console.error('[bt-remote-voice] 拿不到 slots 服务，设置页未注册')
          return
        }
        try {
          slots.inject('settings.section', () =>
            slots.register(
              { name: 'settings.section', id: 'bt-remote-voice', order: 60, label: '蓝牙遥控器语音' },
              Panel,
            ))
        } catch (error) {
          console.error('[bt-remote-voice] 注册设置页失败', error)
        }
      })
    }

    /** 与宿主半区一致：只有整份配置不是对象才报错，归一化在宿主侧做。 */
    const Config = {
      '~standard': {
        version: 1,
        vendor: 'dsh-bt-remote-voice',
        validate(config) {
          if (config === undefined || config === null) return { value: {} }
          if (typeof config !== 'object' || Array.isArray(config)) {
            return { issues: [{ message: 'plugin config must be an object' }] }
          }
          return { value: config }
        },
      },
    }

    return { name, inject, apply, Config }
  },
})
