# 发布清单

本插件已经具备发布所需的全部结构（`dsh.bundle.patch`、`dsh.client`、`files`、
`exports`、`cordis.patch.yml`、LICENSE、双语 README）。剩下的是需要账号的动作。

## 0. 发布前必须通过的验证

```bash
cd dsh-bt-remote-voice
node --check host.js && node --check client.js
npm test                     # 19 项
npm run verify:adpcm         # 期望：最大误差 0
```

真机项（缺一项都不建议发版）：

- [ ] `npm run e2e -- --seconds 60` 里出现 `[audio] X.XXs PCM 已就绪`
- [ ] 同一次的 `>>> 识别结果` 与口中说出的内容一致
- [ ] 面板在 DSH 里能渲染（设置 → 插件 → 蓝牙遥控器语音）
- [ ] 确认键真的能当回车（需要 `input` 组权限）

## 1. 仓库

```bash
git init
git add .
git commit -m "feat: initial release of dsh-bt-remote-voice"
git remote add origin git@github.com:Retrasts/dsh-bt-remote-voice.git
git push -u origin main
```

`package.json` 里补上：

```json
"repository": { "type": "git", "url": "git+https://github.com/Retrasts/dsh-bt-remote-voice.git" },
"homepage": "https://github.com/Retrasts/dsh-bt-remote-voice#readme",
"bugs": { "url": "https://github.com/Retrasts/dsh-bt-remote-voice/issues" }
```

## 2. npm

```bash
npm login
npm publish --access public
```

发版前确认：

- `package.json` 的 `version` 与 `host.js` 的 `PLUGIN_VERSION` 一致
  （`test/load.test.mjs` 可以加一条断言来守住这个）
- `files` 白名单包含 `host.js client.js lib profiles scripts docs cordis.patch.yml README* LICENSE`
- `dependencies` 只有 `dbus-next`（纯 JS，无编译）
- 不要把 `out/`、`*.log`、`node_modules/` 打进包里

发布后自检：

```bash
npm pack --dry-run          # 看清单
npm view dsh-bt-remote-voice versions
```

## 3. 插件市场索引

[docs/MARKET-ENTRY.json](MARKET-ENTRY.json) 已经是**完整可用的 format 1 索引**，
并用 DSH 自己的校验器跑通过：

```bash
$ npm run verify:market
✅ 索引合法：format=1，plugins=1
   分类声明: input, speech
   标签声明: requires-admin, linux-only

   dsh-bt-remote-voice  蓝牙遥控器语音输入
     category=input keywords=8
     0.1.0  →  install spec: dsh-bt-remote-voice@0.1.0
     engines.dsh=>=0.2.2
```

`verify:market` 直接调用 `@deepseek-ai/dsh-plugin-market-index` 的
`parseMarketIndex()` 与 `marketInstallTarget()`，所以条目通过即代表 DSH 的读取器能
接受它。发布前只需要：

1. ~~把 `repository.url` / `homepage` 里的 `OWNER` 换成真实账号~~（已填 `Retrasts`）
2. 把 `versions[0].publishTimestamp` 换成 npm 上真实的发布时间（Unix 秒）
3. 如果图标要显示，补 `icon`（base64 `data:` URL 或绝对 URL，内联解码后 ≤ 32 KiB）

然后把这份索引提交到市场索引仓库。

条目里要保留 `requires.notes` 这条**强制前置条件**——不设 `DisablePlugins = input`
的话设备会把语音切到厂商加密通道，用户会以为是插件坏了：

```
必须先在 /etc/bluetooth/main.conf 的 [General] 段设置 DisablePlugins = input
```

## 4. 版本策略

| 变更类型 | 版本 |
|---|---|
| 新增设备 profile | patch（0.1.x） |
| 修协议/解码 bug | patch |
| 新增平台（macOS/Windows 传输层） | minor（0.2.0） |
| 破坏配置结构 | major |

`PLUGIN_VERSION` 会出现在面板与 `bt_remote_voice` 的 status 输出里，用途是回答
「现在跑的是哪一份代码」——bundle 重新挂载时 Node 的 ES 模块缓存不会失效，
不带版本号很难判断。

## 5. 发布后

- 在 README 的支持设备表里持续累积真机验证记录（型号 + 固件 + 结论）
- `docs/EVIDENCE.md` 每次增加真机条目，不要写未经观测的推断
- 收到「收不到音频」的反馈时，第一个问题永远是：
  **`DisablePlugins = input` 设了吗？**（面板会直接给提示）
