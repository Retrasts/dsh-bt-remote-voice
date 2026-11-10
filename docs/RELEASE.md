# 发布执行单

工程化已经做完，剩下三步需要你的 npm / GitHub 账号。命令可以照着贴。

## 0. 发布前最后一次本地校验

```bash
cd dsh-bt-remote-voice
./scripts/release.sh check
```

它会依次跑：语法检查 → 22 项测试 → ADPCM 交叉验证 → 市场索引校验 → 打包内容预览。
全绿才继续。

## 1. 仓库地址

已填为 `https://github.com/Retrasts/dsh-bt-remote-voice`：
`package.json` 的 `repository` / `homepage` / `bugs` 与 `docs/MARKET-ENTRY.json`
的 `repository` / `homepage` 都指向它。

## 2. 推 GitHub

```bash
git init
git add .
git commit -m "feat: dsh-bt-remote-voice 0.1.0 — BLE ATVV 语音输入插件"
git branch -M main
git remote add origin git@github.com:<你的账号>/dsh-bt-remote-voice.git
git push -u origin main
```

推上去之后 GitHub Actions 会自动跑 `.github/workflows/ci.yml`（Node 20 与 22 两个矩阵，
含 ADPCM 交叉验证）。

## 3. 发 npm —— 用 Trusted Publishing（OIDC）

npm 从 2025 年起禁止"无 2FA 直接 publish"，而长期 automation token 被官方标注为有安全
风险。推荐路径是 **Trusted Publishing**：发布在 GitHub Actions 里用短期 OIDC 凭证完成，
仓库里不存任何 token，产物自带 provenance 签名。

### 3.1 在 npm 上配置 Trusted Publisher

1. 打开 https://www.npmjs.com/package/dsh-bt-remote-voice/access
   （包还没发布时用 pending publisher 入口：
   https://www.npmjs.com/settings/retrasts/publishing）
2. Trusted publishing → **GitHub Actions**
3. 填：

   | 字段 | 值 |
   |---|---|
   | Organization or user | `Retrasts` |
   | Repository | `dsh-bt-remote-voice` |
   | Workflow filename | `release.yml` |
   | Environment | 留空 |

### 3.2 触发发布

```bash
git tag v0.1.0
git push origin v0.1.0
```

或在 https://github.com/Retrasts/dsh-bt-remote-voice/actions 里手动 Run workflow。
workflow 会自己跑：语法 → 22 项测试 → ADPCM 交叉验证 → 市场索引 → 打包预览 →
`npm publish --provenance --access public`。

### 3.3 本地发布（备用路径，需要 2FA）

如果确实要在本机发，账号必须先启用 2FA，然后：

```bash
npm login
./scripts/release.sh publish --otp=123456
```

`prepublishOnly` 里挂了 `check + test + verify:adpcm + verify:market`，任何一项不过
都不会发出去。发布产物是 30 个文件 / 53.8 kB。

## 4. 提交市场索引

拿到 npm 上的真实发布时间后：

```bash
# 把 0 换成真实 Unix 秒
date -d "<npm 上的发布时间>" +%s
```

填进 `docs/MARKET-ENTRY.json` 的 `plugins[0].versions[0].publishTimestamp`，再跑一次：

```bash
npm run verify:market
```

然后把这份索引提交到 DSH 插件市场索引仓库。

## 5. 用户体验验证（发布后自查）

```bash
dsh plugin --profile web add dsh-bt-remote-voice
```

重启 DSH → 设置里应出现「蓝牙遥控器语音」页 → 按住语音键 → 文字进输入框。

## 回滚

```bash
npm unpublish dsh-bt-remote-voice@0.1.0 --force   # 72 小时内可用
```

本地 profile 回滚：`~/.dsh/profiles/web/package.json.bak.*` 是对应时点的备份；
`/etc/bluetooth/main.conf.bak.*` 是禁用 HID 插件之前的 BlueZ 配置。
