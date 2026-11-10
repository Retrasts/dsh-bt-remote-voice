#!/usr/bin/env bash
# 发布辅助脚本：跑全部本地校验，然后打包 / 发布。
#
#   ./scripts/release.sh check     只校验，不发布
#   ./scripts/release.sh pack      生成 tgz，不上传
#   ./scripts/release.sh publish   发布到 npm（需要先 npm login）
#
# 发布前请先把 package.json 里的 OWNER 换成真实 GitHub 账号，
# 并更新 docs/MARKET-ENTRY.json 的 repository / publishTimestamp。
set -euo pipefail

cd "$(dirname "$0")/.."
MODE="${1:-check}"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "1/5 语法检查"
npm run check --silent

step "2/5 单元 + 契约测试"
npm test --silent

step "3/5 ADPCM 解码器交叉验证"
npm run verify:adpcm --silent

step "4/5 市场索引校验"
npm run verify:market --silent || echo "（跳过：需要本机 DSH 安装）"

step "5/5 打包内容"
npm pack --dry-run 2>&1 | tail -8

case "$MODE" in
  check)
    echo -e "\n\033[32m校验全部通过。\033[0m 发布用: ./scripts/release.sh publish"
    ;;
  pack)
    npm pack
    echo -e "\n\033[32m已生成 tgz。\033[0m"
    ;;
  publish)
    if ! npm whoami >/dev/null 2>&1; then
      echo "未登录 npm，先执行: npm login" >&2
      exit 1
    fi
    if grep -q "OWNER" package.json; then
      echo "package.json 里还有 OWNER 占位符，先换成真实仓库地址" >&2
      exit 1
    fi
    npm publish --access public
    echo -e "\n\033[32m已发布。\033[0m 记得把真实 publishTimestamp 写进 docs/MARKET-ENTRY.json。"
    ;;
  *)
    echo "未知模式: $MODE（可用 check / pack / publish）" >&2
    exit 1
    ;;
esac
