# CHANGELOG — dsh-add-accio-rc1-v0.2.2

基线：`tidys/dsh-connect-accio` master（解包于 2026-11-13），上游 release 为 v0.2.0。
目标宿主：DeepSeek Harness `0.2.2-rc.1`；实测 Accio `0.38.2` / Windows 11。
**非官方第三方 fork，与上游作者无关；状态为 RC（候选发布），仅在单台机器验证。**

## 验证状态（2026-11-14 15:00 更新）：图片真正可用

- ✅ **网关级实测**：用本机凭据向 `generateContent` 发一条带 1×1 红色 PNG 的
  `inline_data` 请求，模型 `1Drift-F8hS3mK7pL6I`（Qwen 3.8 Flash，free，x0.003）
  在 6.2 秒内完整返回 `The image is a solid red square.` ⇒ 网关接受图片 part，
  模型确实收到像素。目录接口同时确认 15 个模型中 10 个 `multimodal: true`。
- ✅ **离线端到端 11 项**：image 块 → 短标记 → `inlineData`；base64 与磁盘附件
  字节逐字节一致；OpenAI string / array 两种 content 形态都通过；`toSnake` 产出
  `inline_data` / `mime_type`；路径穿越、非法 id、缺失附件、超限均降级为文字；
  纯文本 / 系统 / 工具消息路径不变。
- ⚠️ **仍未做**：改动代码后在 DSH 里重启插件、从输入框贴图发一条完整会话
  （网关级与离线级已通过，但这条端到端路径需重启后确认）。
- 改动文件：`lib/adapter.js`、`lib/shim.js`，新增 `lib/image-bridge.js`；
  `lib/index.js` 仅改注释。`gateway.js` / `oscrypt.js` / `credits.js` 一行未动。

## 验证状态（2026-11-13 13:43 更新）

- ✅ 运行时实测：DSH 重启后 RC1 成功加载；`/credits` 200（账号/积分正常）、
  `/refresh` 200 且 `sent:["llm/models-updated","llm/adapters-updated"]`、`/diag` 404
  （临时诊断代码已清除）、无新崩溃日志。
- ✅ 离线：签名库可从 `versions\0.38.2` 自动探测；全部 `lib/*.js` 通过 `node --check`；
  与上游 master 全量 `diff -rq` 确认只有三个 lib 文件被改。
- ✅ 17:20 离线函数级：`toPiModel()` 对 `multimodal:true/false` 分别返回
  `['text','image']` / `['text']`；`stripImageBlocks()` 正确替换 image 块、
  纯文本请求返回原对象；全部 `lib/*.js` 通过 `node --check`。
- ⚠️ 未做端到端：带图会话（恢复贴图后）、实际对话的请求签名链路、全新 profile 的模型选择器；
  广播修复未做对照实验。详见 README「发布状态」。

## RC1 (2026-11-13)

### 修复

1. **模型选择器不出现 Accio 分组**（host 正常、卡片正常、15 个模型都在）
   - `lib/index.js`：新增 `broadcastCatalogChange()`，目录预热后在 0 / 0.5 / 2 / 6 / 15 秒
     广播 `llm/models-updated` + `llm/adapters-updated`；定时器随 fiber 释放。
   - `lib/index.js`：新增只读路由 `GET /plugins/dsh-connect-accio/refresh`，可手动重发事件。
   - 原因：前端 `ModelDirectoryResolver` 只在 client 挂载时拉一次 `session/modelCatalog`，
     插件异步注册 adapter 后没有事件通知它重算。

2. **发消息报 `pi-ai image input requires the durable attachment service` / `UNSUPPORTED_CONTENT`**
   - `lib/adapter.js`：新增 `stripImageBlocks()`，覆盖 `adapter.streamWithSnapshot`，
     把历史中的 `image` 块替换为文本占位；`stream()` 和 `resolveModel().stream` 都走这一层。
   - `lib/adapter.js` / `lib/index.js`：**保留上游按 `multimodal` 生成 `input` /
     `inputModalities` 的逻辑**（15 个模型中 10 个为 `true`），让 DSH 允许贴图。
   - 原因：回环 shim 只序列化 `text`；DSH 在把请求交给 shim 之前会检查
     `contentHasImage` 并要求注入官方 `llm-pi-ai` 才有的 attachment service。
     图片块在检查之前就被降级，因此两个检查都不会触发。
   - **17:20 修正**：最初版本把整组模型一律声明为 text-only，前端因此直接提示
     「当前模型不支持图片」、连图都贴不上。砍声明是多余的，已按 `multimodal` 逐个恢复。
     现阶段贴图能发送，但模型收到的是文字占位、看不到像素。（**此结论已于 2026-11-14 被图片桥接推翻，见文首「验证状态」**）

3. **Accio 升级后签名库找不到**
   - `lib/security-guard.js`：新增 `resourcesRoots()`，扫描 `<Accio>\versions\<版本>\resources\...`
     并按版本号倒序，同时保留 `<Accio>\resources\...` 旧布局；`import` 增加 `readdirSync`。
   - 不再需要手工建目录联接，也不再需要 `ACCIO_SECURITY_GUARD_DIR`。

### 安装方式（不在代码里，但属于本版的一部分）

- `dsh plugin add <本地目录>` 生成的 `link:` 符号链接会让源码落在 profile 之外，
  peer 依赖（`@deepseek-ai/schemastery` 等）无法解析，插件入口抛错被宿主静默跳过。
  必须把包内容复制成 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-connect-accio`
  **真实目录**；详见 README 第二节。
- 尽量不要在插件管理器里对本插件点「重装 / 更新」，否则 pnpm 会按 `link:` 重建链接。
- **13:43 状态更新**：`package.json` 的 link 目标修正后重启，pnpm 将
  `node_modules\dsh-connect-accio` 重建为 **Junction** 指向本包目录，插件仍正常加载
  （`/credits` 200、`/refresh` 200、无崩溃日志）。⇒ 上午「链接一定失败」的断言过头，
  已把 README/CHANGELOG 的绝对措辞降级；关键条件是 link 目标存在且可被解析。

### 元数据 / 文档

- `package.json`：`version` `0.2.0` → `0.2.2-rc.1`，description 注明适配范围；
  **包内 `name` 保持 `dsh-connect-accio`**，避免与已装 bundle 重复注册。
- `README.md` 重写；新增 `CHANGELOG.md`、`original/`。

### 未改动

`gateway.js`、`client.js`、`credits.js`、`shim.js`、`oscrypt.js`、`paths.js`、
`cordis.patch.yml`、图标、`LICENSE` 与上游 master 逐字节一致。

## 目录说明（original/）

| 目录 | 内容 |
| --- | --- |
| `original/upstream-master/` | 上游 master 的 `index.js` / `adapter.js` / `security-guard.js` 原样 |
| `original/pre-rc1/` | RC1 修改前的基线（含目录广播修复，但没有图片修复与版本化签名库探测） |

回退时按需覆盖 `lib/` 下同名文件，然后禁用/启用插件重载 fiber。
