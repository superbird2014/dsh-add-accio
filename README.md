# dsh-add-accio-rc1-v0.2.2

把本机已登录的 **Accio** 模型接入 **DeepSeek Harness (DSH)** 的兼容性修复版。

> **非官方第三方修改版（fork）**，原项目为 [`tidys/dsh-connect-accio`](https://github.com/tidys/dsh-connect-accio)（MIT）。
> 本仓库与上游作者、Accio、DeepSeek 均无关联；改动由第三方在单台机器上完成，未经上游审核。

- **目标宿主**：DeepSeek Harness `0.2.2-rc.1`（ProductVersion `0.2.2.0`）
- **实测环境**：Windows 11 + Accio `0.38.2` + DSH `0.2.2-rc.1`，15 个可见模型
- **基线**：上游 `tidys/dsh-connect-accio` v0.2.0 / master（MIT）
- **包内 npm name 仍为 `dsh-connect-accio`**，原因见[为什么包名没改](#为什么包名没改)
- **插件版本号 `0.2.2-rc.1` 是本 fork 自己的版本号**，与 DSH 的版本号相同纯属命名巧合，两者没有对应或配套关系。

## ⚠️ 发布状态：RC（候选发布），请勿当作稳定版

本包**只在一台 Windows 机器、一组版本组合上验证过**，没有自动化测试、没有 CI、没有在第二台机器或干净的 profile 上装过。

已验证（2026-11-13，运行时实测）：插件成功加载、账号/积分只读接口 200、
`/refresh` 事件广播 200、host 侧 15 个模型与逐模型解析全部通过、无崩溃日志。
另经离线函数级验证：签名库可从 `versions\0.38.2` 自动探测到。

2026-11-14 补充（图片通路）：新增 `lib/image-bridge.js`，把 DSH 的附件引用写成
短文本标记，由回环 shim 按 `sha256` 读回图片字节、转成 Accio 网关的 `inlineData`
图片块。离线 11 项端到端测试通过（含字节一致性、路径穿越防护、超限降级）；
并向网关发出一条真实的 1×1 PNG 请求，`Qwen 3.8 Flash` 正确回答
"The image is a solid red square."。签名链路也在这次实测中被覆盖。

**尚未完成的端到端验证**（2026-11-14 更新）：
1. **DSH 内完整带图会话**：代码改动后尚未重启插件重跑。网关级与离线级已通过，
   但「从输入框贴图 → 模型答对图内容」这条完整路径仍需重启后确认一次；
2. 模型选择器在**全新 profile** 上是否出现 Accio 分组；
3. 上表第 2 项的广播修复**未做对照实验** —— 实测是「加入广播 + 禁用/启用插件」后分组出现，
   无法排除「禁用/启用本身就刷新了目录」这一因素。它是针对 0.2.2-rc.1 的**实验性 workaround**，
   对其他 DSH 版本不保证有效。

在这三项补齐前，建议只开 issue / 发 RC 包，**不要打正式 Release、不要宣称稳定可用**。

---

## 一、这个包修了什么

| # | 现象 | 根因 | 本包的处理 |
| --- | --- | --- | --- |
| 1 | 设置页没有 Accio 卡片，模型一个都不出现 | 首次安装时 `dsh plugin add <本地目录>` 生成的符号链接指向 profile 之外的源码，`@deepseek-ai/schemastery` 等 peer 无法解析，插件入口抛错被宿主静默跳过 | 保守做法：把包内容**复制成 profile 内的真实目录**（见第二节）。**状态更新**：13:43 重启后 pnpm 按修正过的 `link:` 重建为 Junction 指向本包目录，插件同样正常加载 —— 所以关键不是「必须真实目录」，而是 link 目标必须存在且能被解析 |
| 2 | 卡片和积分都正常、宿主能列出 15 个模型，但对话界面的模型选择器没有 Accio 分组 | 推断：DSH 前端 `ModelDirectoryResolver` 只在 client 启动时拉一次 `session/modelCatalog`，之后仅靠 `llm/*-updated` 事件刷新；插件在异步 setup 里注册 adapter 后没有事件通知前端。**此项未做对照实验** | 目录预热完成后在 0 / 0.5 / 2 / 6 / 15 秒分五次广播 `llm/models-updated` + `llm/adapters-updated`；另提供只读 `/plugins/dsh-connect-accio/refresh` 手动触发。**实验性 workaround**，仅 0.2.2-rc.1 实测有效 |
| 3 | 换了 Accio 版本后签名库找不到 | Accio 0.38+ 把真实程序放进 `<Accio>\versions\<版本>\resources\...`，`<Accio>\resources` 是空的；上游只探测扁平目录 | 自动扫描 `versions\*` 并按版本号倒序探测，同时保留旧布局；不再需要手工建 Junction 或设 `ACCIO_SECURITY_GUARD_DIR` |
| 4 | 带图消息报 `UNSUPPORTED_CONTENT`；或能贴图但模型看不到图 | DSH 的 `image` 块只带附件引用（`attachmentId: "sha256:…"`），独立 connector 没有宿主的 durable attachment service，pi-ai 在请求到达 shim 前就拦下；回环 shim 又只序列化 `text` 块 | **保留**上游 `multimodal` 声明；新增 `lib/image-bridge.js`：`streamWithSnapshot` 入口把 `image` 块换成携带附件 id 的短文本标记绕开检查，shim 按 sha256 从 `~/.dsh/attachments/v1/objects/` 读回字节并生成 Gemini `inlineData` part。2026-11-14 网关实测模型能正确识别图片内容 |

第 4 项在 2026-11-14 又推进了一步：早先只是「能贴图、看不到图」，现在图片字节
真的会送到网关。做法是把 DSH 的附件引用写成短文本标记（**不含 base64**，避免污染
上下文与 token 计数），由 shim 在发往 Accio 前读盘还原成 `inlineData` part。
每次请求最多 4 张、单张 4 MB、合计 8 MB；读不到附件或超限时该张图降级成一行
文字说明，而不是让整条请求失败。

> **为什么有的模型能贴图、有的仍提示不支持？** Accio 目录里 15 个模型中
> 10 个 `multimodal: true`、5 个 `false`，本包如实跟随这个标志。这是正常的，不是故障。

---

## 二、安装

### 前置条件

| 依赖 | 说明 |
| --- | --- |
| Windows 10/11 | DPAPI 凭据解密 + Windows 版 `security_guard.node` |
| DeepSeek Harness | 已安装并可启动 |
| Accio 桌面端**已登录** | 插件读取本机登录态，不提供登录入口 |

### 2.1 本机已经装过 accio 插件（升级到 RC1，推荐）

插件已加载在内存里，改文件**必须重载 fiber** 才生效。

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$target  = Join-Path $profile "node_modules\dsh-connect-accio"
$src     = "<把本压缩包解开后的目录>"        # 例如 $PSScriptRoot\dsh-add-accio-rc1-v0.2.2

# 1) 备份配置（只备份，不删）
Copy-Item "$profile\package.json" "$profile\package.json.bak-rc1" -Force
Copy-Item "$profile\cordis.patch.yml" "$profile\cordis.patch.yml.bak-rc1" -Force

# 2) 若当前是 link: 符号链接，改名保留而不是删除
$item = Get-Item $target -Force
if ($item.LinkType) { Rename-Item $target "dsh-connect-accio__linkbak" }

# 3) 复制成 profile 内的真实目录（这是关键，peer 依赖才能解析）
Copy-Item $src $target -Recurse -Force
```

然后在 **设置 → 插件** 把 **DSH Connect Accio 禁用再启用**（这次的意义是加载新代码，不是重复排障动作）；必要时完全退出 DSH 再启动。

> 尽量别在插件管理器里对它点「重装 / 更新」：pnpm 会按 `link:` 重建链接。
> **状态更新（2026-11-13 13:43）**：本机修正 `package.json` 的 link 目标后重启，pnpm 把
> `node_modules\dsh-connect-accio` 重建为 **Junction** 指向本包目录，插件仍正常加载
> （`/credits` 200、`/refresh` 200、无崩溃日志）。因此「链接一定失败」不是绝对的；
> 若重建后卡片消失，再按上面第 2、3 步换回真实目录即可。

### 2.2 全新安装（本机从未装过）—— 未验证路径，仅供参考

> ⚠️ **这一节没有在干净的 profile 上验证过。** 如果不是必须全新安装，
> 建议先按 DSH 正常流程装一次上游插件，再走 2.1 升级，风险更低。

思路只有两步：**先让 DSH 登记这个 bundle，再把 `link:` 换成真实目录**。

1. 用 CLI 登记本地目录（DSH 对本地目录固定使用 `link:` 协议）：

   ```text
   "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<本包解压目录>"
   ```

   或在 DSH 设置 → 插件 →「添加插件 / 安装第三方插件」里填本包目录。
   若 CLI / GitHub 不通，可手工编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   `dependencies` 加 `"dsh-connect-accio": "file:<本包解压目录>"`，
   `dsh.profile.bundles` 加 `"dsh-connect-accio"`。
   **不要写 `"*"`** —— 那会让 pnpm 去 npm registry 找同名包。

2. **不要**手工往 `cordis.patch.yml` 加 `- insert: dsh-connect-accio`。
   插件自带 `cordis.patch.yml`，由 `package.json` 的 `dsh.bundle.patch` 自动应用；
   本机实测 profile 的 patch 里没有该条目，插件照样正常加载。
   手工再加同一 id 有重复注册、导致 DSH 起不来的风险。

3. 按 2.1 的第 2、3 步把 `node_modules\dsh-connect-accio` 换成真实目录，然后重启 DSH。

`dsh --profile desktop` 会被拒绝（desktop profile 由 Electron 独占），CLI 只能用来管插件。

---

## 三、验证

1. **设置 → 插件**：出现带 Accio 图标的卡片，显示账号与三类积分。
2. **对话界面 → 模型选择器**：出现 **Accio** 分组，15 个模型带 `· x0.003` ~ `· x2.8` 倍率后缀
   （Qwen 3.8 Flash、GLM 5.3 Flash、MiniMax M3、DeepSeek V4.1 Flash、GLM-5.1 …）。
   列表有搜索框，输 `x0.003` 最快。
3. 发一条**纯文本**消息，应正常返回并扣 Accio 积分；再选一个标了
   `multimodal` 的模型（如 `Qwen 3.8 Flash` / `Qwen 3.8 27B`）贴一张图，
   模型应能描述图内容。若仍说看不到图，先禁用再启用插件（或完全重启 DSH）加载新代码。
4. 只读自检（本机回环，不消耗积分）：

```text
GET http://127.0.0.1:<webServer端口>/plugins/dsh-connect-accio/credits   -> 200 账号/积分
GET http://127.0.0.1:<webServer端口>/plugins/dsh-connect-accio/refresh   -> 200 {"ok":true,...} 强制前端重拉目录
```

端口每次启动随机，可从 DSH 进程监听端口里找那一对（webServer + 回环 shim）。
DSH 的插件日志走 DevTools Console，不落盘；`--enable-logging=file` 抓不到它。
若卡片在而分组仍不出现，先 `Ctrl+R`，再禁用/启用插件，最后才重启应用。

---

## 四、与上游 v0.2.0 的逐文件差异

| 文件 | 改动 |
| --- | --- |
| `lib/index.js` | 新增 `broadcastCatalogChange()` 定时广播、`/refresh` 只读路由；`registerModelDiscovery` 与离线回退分支按 `multimodal` 如实声明 `inputModalities` |
| `lib/adapter.js` | `toPiModel()` 保留上游按 `multimodal` 生成 `input` 的逻辑；新增 `stripImageBlocks()` 并覆盖 `adapter.streamWithSnapshot`，在 pi-ai 检查前降级图片块 |
| `lib/security-guard.js` | 新增 `resourcesRoots()`，支持 `<Accio>\versions\<版本>\resources\...` 并保留扁平布局 |
| `package.json` | `version` → `0.2.2-rc.1`，description 注明适配范围 |
| `README.md` / `CHANGELOG.md` | 重写 |
| `original/` | 上游 master 原版与 RC1 前一版的三文件快照，供 diff 与回退 |

其余文件（`gateway.js`、`client.js`、`credits.js`、`shim.js`、`oscrypt.js`、`paths.js`、
`cordis.patch.yml`、图标、LICENSE）与上游一致，未改动。

### 为什么包名没改

归档名和顶层目录改成了 `dsh-add-accio-rc1-v0.2.2`，但包内 `name` 仍是
`dsh-connect-accio`：DSH 用包名索引 `dsh.profile.bundles` 和 `cordis.patch.yml` 的
`id`。改名会让 RC1 被当成一个**新插件**，与已装的旧插件同时注册 `accio` provider，
触发 `duplicate factory registration` 之类的冲突，甚至让 DSH 起不来。
对一个「就地升级包」来说，保持 ID 不变才是对的。

---

## 五、已知限制

- **图片有额度上限**：每次请求最多 4 张、单张 4 MB、合计 8 MB；附件文件读不到或
  超限时，该张图会降级成一行文字说明，不会让整条请求失败。只有目录里标了
  `multimodal: true` 的 10 个模型能贴图，其余 5 个仍会提示不支持——这是上游能力，
  不是故障。图片只在本机回环内流转，最终仍由 Accio 网关处理，遵循其隐私政策。
- **DSH 内完整带图会话尚未重跑**：网关级带图请求与离线链路已验证，但代码改动后
  需要重启插件（或完全重启 DSH）再发一张图确认，别把网关实测当成界面实测。
- **仅 Windows**：DPAPI + Windows 版 `security_guard.node`。
- **依赖 Accio 登录态与安装**：插件不提供登录入口；卸载 Accio 后签名库消失，插件失效。
- **token 刷新只在内存**：轮换后的 refresh token 不写回 Accio 的私有凭据文件；
  若磁盘上的 refresh token 已失效，请在 Accio 里重新登录。
- **计费在 Accio 侧**：拉目录、刷 token、查积分不消耗积分，对话消耗。
- Accio 是闭源客户端，接口随版本可能变化；本包针对 0.38.2 实测。

### 安全与隐私边界（相对上游未改动）

本 fork 修改了 `lib/index.js`、`lib/adapter.js`、`lib/security-guard.js`、
`lib/shim.js` 四个文件，并新增 `lib/image-bridge.js`（图片桥接，纯函数、可离线测试）。
其中 `shim.js` 的改动只涉及把图片标记展开成 `inlineData` part；
**没有改动**凭据读取与 DPAPI 解密（`oscrypt.js`）、网关签名与请求构造（`gateway.js`）、
积分查询（`credits.js`）；不新增对外网络端点，不记录或上传 token。
图片字节从本机 `~/.dsh/attachments/` 读出后只经 127.0.0.1 回环 shim 发往 Accio 网关。
新增的 `/refresh` 只在本机发两个通知事件，`/credits` 沿用上游 loopback-only 保护。

### 公开分发前请完成

1. 补齐「发布状态」里列出的三项端到端验证；
2. 仓库名带 `-fork` 或 `-rc`，首屏保留上游链接与非官方声明；
3. 先以 RC / pre-release 提供，不要打正式 GitHub Release；
4. 保留 `LICENSE`（MIT 要求保留原版权声明）与 `original/` 里的上游快照。

---

## 六、工作原理（保留上游说明）

```text
DSH PiAiAdapter
  -> 回环 shim（OpenAI 线格式，127.0.0.1 + 进程内随机 bearer）
  -> AccioClient
  -> POST https://phoenix-gw.alibaba.com/api/adk/llm/generateContent?sg_k=<md5(requestId)>
  -> SSE: content.parts[].text | function_call，thought 标记，usage_metadata
```

凭据链路：

```text
%APPDATA%\Accio\Local State        os_crypt.encrypted_key（base64，"DPAPI" 前缀）
        │  DPAPI CryptUnprotectData（当前 Windows 用户）
        ▼
   32 字节 OSCrypt AES 密钥
        │  AES-256-GCM，blob = "v10" + 12B nonce + 密文 + 16B tag
        ▼
%APPDATA%\Accio\credentials.enc  ->  { accessToken, refreshToken, expiresAt, sgcookie, user }
```

签名由 Accio 自带的 `security_guard.node` 完成，不需要中间人抓包：

```js
sg.getSecurityFactorsForWeb(JSON.stringify({
  appkey: '35336201',          // win32；darwin 为 35337600
  urlInput: fullUrlWithQuery,  // 必须含 ?sg_k=，签的是将要请求的那个 URL
}))
// -> pctb-x-sign / pctb-x-umt / pctb-x-api / pctb-x-t ...
```

设置卡片走只读路由 `/plugins/dsh-connect-accio/credits`（只接受 loopback，外部 Origin 403）：
`POST /api/auth/userinfo`（token 在 body）、`GET /api/entitlement/currentSubscription`、
`/quota`、`/listGrantRecords`、`/listUserMessageBill`、`/queryCreditUsageTrend`（token 在 query）。
Accio 没有签到接口，卡片显示每日重置倒计时而不是签到按钮。

配置字段：`userDataDir`、`configRoot`、`securityGuardDir`、`enabled`、`lastCatalog`，
一般三项路径留空即可；非标准安装可设 `ACCIO_SECURITY_GUARD_DIR` 兜底。

---

## 七、回退与卸载

- **回退代码**：`original/upstream-master/` 是上游原版，`original/pre-rc1/` 是 RC1 前一版
  （已含目录广播修复）。按需选一份覆盖 `lib/` 同名文件，再禁用/启用插件重载 fiber。
- **回退配置**：用安装时生成的 `*.bak-rc1` 还原 `package.json` / `cordis.patch.yml`。
- **完全卸载**：`dsh plugin --profile desktop remove dsh-connect-accio`，
  再手工从 `dsh.profile.bundles` 删掉 `"dsh-connect-accio"`，重启 DSH。

## 许可

MIT（沿用上游 `tidys/dsh-connect-accio`）。
