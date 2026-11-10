/**
 * 发布后把 npm 上的真实发布时间写进市场索引条目。
 * 用法: node scripts/sync-market-timestamp.mjs
 */
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const marketPath = 'docs/MARKET-ENTRY.json'
const market = JSON.parse(fs.readFileSync(marketPath, 'utf8'))

const url = `https://registry.npmjs.org/${pkg.name}`
let meta
try {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`registry 返回 ${res.status}`)
  meta = await res.json()
} catch (error) {
  console.error(`读取 ${url} 失败: ${error.message}`)
  console.error('如果还没发布，先跑 ./scripts/release.sh publish')
  process.exit(1)
}

const published = meta?.time?.[pkg.version]
if (!published) {
  console.error(`registry 里没有 ${pkg.name}@${pkg.version} 的发布时间`)
  process.exit(1)
}
const seconds = Math.floor(new Date(published).getTime() / 1000)
console.log(`${pkg.name}@${pkg.version} 发布于 ${published} → ${seconds}`)

const entry = market.plugins.find((p) => p.name === pkg.name)
if (!entry) {
  console.error('市场索引里找不到本插件条目')
  process.exit(1)
}
let changed = false
for (const v of entry.versions) {
  if (v.version === pkg.version && v.publishTimestamp !== seconds) {
    v.publishTimestamp = seconds
    changed = true
  }
}
if (!entry.versions.some((v) => v.version === pkg.version)) {
  entry.versions.unshift({
    version: pkg.version,
    publishTimestamp: seconds,
    source: { type: 'npm' },
    engines: { dsh: '>=0.2.2' },
  })
  changed = true
}
fs.writeFileSync(marketPath, `${JSON.stringify(market, null, 2)}\n`)
console.log(changed ? `已更新 ${marketPath}` : '时间戳已是最新')
