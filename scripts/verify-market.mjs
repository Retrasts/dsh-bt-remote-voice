/**
 * 用 DSH 自己的校验器验证市场索引条目。
 * 用法: node scripts/verify-market.mjs [docs/MARKET-ENTRY.json]
 */
import fs from 'node:fs'
import path from 'node:path'

let parseMarketIndex, marketInstallTarget, MarketIndexError
try {
  ({ parseMarketIndex, marketInstallTarget, MarketIndexError } = await import('@deepseek-ai/dsh-plugin-market-index'))
} catch {
  // 插件工程里没有这个依赖时，从 DSH 的 npx 安装目录借一份
  const fallback = '/home/zeiet/.npm/_npx/72500ffcd8799faa/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'
  ;({ parseMarketIndex, marketInstallTarget, MarketIndexError } = await import(fallback))
}

const file = process.argv[2] ?? path.join(process.cwd(), 'docs', 'MARKET-ENTRY.json')
const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
const indexUrl = 'https://example.com/plugin-market/index.json'

try {
  const index = parseMarketIndex(raw, indexUrl)
  console.log(`✅ 索引合法：format=${index.format}，plugins=${index.plugins.length}`)
  console.log(`   分类声明: ${Object.keys(index.metadata.categories).join(', ')}`)
  console.log(`   标签声明: ${Object.keys(index.metadata.labels).join(', ')}`)
  for (const plugin of index.plugins) {
    console.log(`\n   ${plugin.name}  ${plugin.title?.zh ?? plugin.title?.en ?? ''}`)
    console.log(`     category=${plugin.metadata.category ?? '-'} keywords=${plugin.metadata.keywords.length}`)
    for (const v of plugin.versions) {
      const target = marketInstallTarget(plugin.name, v)
      console.log(`     ${v.version}  →  install spec: ${target.spec}${target.registry ? ` (registry ${target.registry})` : ''}`)
      console.log(`     engines.dsh=${v.engines.dsh ?? 'any'}`)
    }
  }
  process.exit(0)
} catch (error) {
  if (error instanceof MarketIndexError) {
    console.error(`❌ 校验失败 @ ${error.path}: ${error.reason}`)
  } else {
    console.error('❌ 校验异常:', error.message)
  }
  process.exit(1)
}
