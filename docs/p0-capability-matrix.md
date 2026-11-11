# P0 能力矩阵与 G0 判定

- 日期：2026-11-10（Asia/Shanghai）。
- 对应方案：[跨会话登录态与文件共享执行方案](cross-session-sharing-plan.md) 第 8 节 P0。
- 状态：**P0 探针已完成，测试资源已回收；G0 判定见文末，结论不是全绿。**
- 边界：全部用虚构站点与虚构 Cookie/localStorage，未读取、未复制任何真实凭据；未改动运行中的插件、未重启、未清理用户数据。

## 1. 基线与环境

| 项 | 事实 | 来源 |
|---|---|---|
| 代码基线 | HEAD `63c76e8`（v0.5.1），工作树仅未跟踪 `docs/cross-session-sharing-plan.md` | `git log -1`、`git status --short` |
| 部署形态 | 运行实例来自 `file:<artifacts>/dsh-browser-live-0.5.0.tgz`（宿主上的升级产物目录），是**打包安装的副本**，不链接工作树 | `~/.dsh/profiles/web/package.json:13` |
| 运行时 | DSH `0.2.1-rc.2`，Node `22.23.4`，Docker `29.9.2` | 包内 `package.json`、`node -v`、`docker version` |
| 浏览器 | 宿主 Chrome `156.0.8078.47`；Neko 镜像 `neko-chromium-cdp:latest` 内 Chromium `154.0.8037.57` | `/json/version` |
| Playwright | `playwright-core 1.63.0-alpha-2026-08-31`，`@playwright/mcp 0.0.80` | 包内 `package.json` |
| 文件沙箱 | 宿主提供 `@deepseek-ai/dsh-fs`：`resolve`/`writeText`/`writeBytes`/`fs/write-intent` 与 sandbox backend | `dsh-fs/lib/types/index.d.ts` |

**部署结论（会影响后续每一步验收）**：本次 v0.5.1 修复（recipe 步骤契约、provider 准入自愈）**没有**进入运行实例；重启也不会加载，必须先重新打包安装到 profile。此前“重启即可生效”的判断不成立。

## 2. 探针方法

- 虚构站点 `127.0.0.1:38917`：首段 inline 脚本读取 `localStorage['p0_seed']` 与 `document.cookie`；另有 302 跳转页、模拟登录页（写 localStorage 与 cookie）、2 MiB 下载；`38918` 提供 4 MiB 慢速下载（64 KiB / 100 ms）。
- 隔离容器 `neko-p0probe`：独立名字、CDP `39444`、Web `39445`、WebRTC mux `39446`、下载目录绑定到 `/tmp/p0/dl`，与任何用户会话无关。
- 两条执行路径都测：宿主直接启动 Chrome（等价容器内启动）与 `connectOverCDP`（插件的真实形态）；产物路径用 `@playwright/mcp` CLI 直连容器 CDP。
- 测试后：容器 `docker rm -f`、两个临时 HTTP 服务停止、`/tmp/p0` 与工作区内 `.p0-*` 全部删除。

## 3. 能力矩阵

| 编号 | 能力 | 结论 | 关键证据 | 限制 |
|---|---|---|---|---|
| C1 | Cookie 首请求恢复 | **支持** | 首次导航前 `addCookies`，服务器收到的首个 `/first` 请求即带 `p0_cookie=SEED_COOKIE` | 仅验证 http 单 origin；SameSite/Partitioned 未测 |
| C2 | httpOnly / 会话 Cookie | **支持** | httpOnly 值不出现在 `document.cookie`，但请求与 `context.cookies()`（含 attached context）都能拿到，`expires: -1` 正常 | 无 |
| C3 | localStorage 首脚本前恢复 | **支持（受控）** | `addInitScript` 播种后，页面首段 inline 脚本读到 `SEED_VALUE`；用户登录写 `USER_VALUE` 后再次导航不被覆盖 | `playwright-core 1.63` **没有**移除 init script 的 API，必须靠“仅当键不存在才播种 + 一次性 epoch 标记”收口（见 5.1） |
| C4 | 重定向 / 新标签页 | **支持** | 302 到 `/first` 后状态仍在；新开标签同源读到同一份状态，无重复播种 | 未覆盖 SSO 跨 origin |
| C5 | 账号冲突 / SSO 域 | **未验证（设计门禁）** | 单 origin 探针无法构造 | 需两账号 + 允许域 + SSO 域的用例，属 G0 缺口 |
| C6 | IndexedDB | **不支持（无 API）** | 页面内 `indexedDB.databases()` 可用，Playwright/MCP 无导出/导入接口 | 只能用自定义脚本实现，v1 排除 |
| C7 | 原生 `browser_live_*` 路径拦截 | **支持** | 工具层在 `tools/execute` 统一接入，`browser_live_*` 全部经 `withSession` | 需把协调器接到 `withSession`，不能散落在各工具 |
| C8 | 直接 MCP 路径拦截 | **支持** | provider 的 `tools/execute` 钩子按 `mcp__playwright-mcp__` 前缀拦截；现场证据：`session-4cad93b9` 第 1 轮第 236 步 `browser_gateway_enable` 即被该闸拦下 | 同上 |
| C9 | `gateway_call` 间接调用拦截 | **可拦截（待实现+用例）** | 网关入参固定为 `{tool, arguments}`（[server.js:94-107](../lib/gateway/server.js#L94-L107)），策略层可读 `exec.arguments.tool` 与 `exec.arguments.arguments`；现有 14 项网关测试覆盖透传与图片块 | 策略层尚未读取内层工具名，属 G0 缺口 |
| C10 | MCP 落盘（`--output-dir`） | **支持** | 指定目录后截屏产生 `page-*.png`（3219 B）+ `page-*.yml` + `console-*.log`；返回 content 为 `text`+`image`，文本里是相对路径链接 `../../home/...` | 无 `structuredContent`，产物只能靠目录扫描识别；yml/log 属额外文件，需按类型过滤 |
| C11 | 下载完成信号（容器真实路径） | **支持（目录级）** | 慢速下载期间目录出现 `Unconfirmed 358830.crdownload` 并逐块增长至 4194304 B，完成后重命名为 `slow-report.pdf`（4194304 B） | MCP 调用本身返回 `isError: true` 的 `Error: Download is starting`（误导），**不能当失败**；无完成事件透传，只能轮询目录 + 排除 `.crdownload` |
| C12 | 下载完成信号（宿主直连 / raw Playwright） | **受限** | 直接 `connectOverCDP` 时 Playwright 截获下载（`context.on('download')` 触发），文件**不落到**绑定目录 | 与 MCP 行为不同，采集器必须按实际服务端实现选择路径 |
| C13 | 绑定挂载一致性 | **需注意** | 宿主 `rm -rf` 后重建下载目录，容器仍写旧 inode，宿主看到空目录 | 迁移/清理流程禁止重建在用下载目录 |
| C14 | 工作区写授权 | **有接入点，现为旁路** | 现有 `save` 用裸 `fs.copyFileSync`（[tools.js:676-678](../lib/tools.js#L676-L678)） | P2 必须改走 `@deepseek-ai/dsh-fs` 的 resolve + write + `fs/write-intent` |
| C15 | 宿主身份来源 | **不足** | 宿主只提供 harness-home 级匿名 UUID（`@deepseek-ai/dsh-anonymous-user-id`），无 per-user/per-session 身份；会话头只有 `cwd`/`agentPreset` | scope 只能定义为“专用 profile 内管理员显式列入的可信会话”，不得宣称多租户隔离 |
| C16 | scope 0 独占性 | **未支持** | 池内 slot 0 仍是 legacy `neko` 共享容器（[service.js:7](../lib/service.js#L7)、`LEGACY.slot`） | P1 必须先取消该例外 |

## 4. 关键结论与影响

1. **登录态恢复的技术前提成立**（C1–C4）：Cookie 在首个 HTTP 请求即到位，localStorage 在页面首段脚本之前到位，且不会在用户登录后被快照回滚。这解除了方案 5.2 第 3 条最担心的风险——不需要“先访问业务页再回填”。
2. **恢复必须带一次性闸门**（C3）：因为无法移除 init script，播种脚本必须以“本实例已恢复 epoch”为条件，否则用户登出（页面删键）后会被旧快照重新注入，正是方案 5.2 第 7 条禁止的“后续导航反复写回”。
3. **MCP 与 raw Playwright 的下载语义不同**（C11/C12）：采集器要以“服务端是谁”分流，而不是假定 MCP 行为；MCP 路径的 `Download is starting` 是**成功信号被误报成错误**，A10 判定要专门处理。
4. **产物元数据不足**（C10）：`structuredContent` 缺失，截图/PDF 只能扫 `--output-dir`；文件名与相对路径链接不能作为可信来源。
5. **写路径现状有旁路**（C14）：`browser_live_download save` 绕过 `fs` 策略，P2 必须替换，否则 A11 无法通过。
6. **身份不足**（C15）：P0 无法验证“可信 scope”，只能落到管理员白名单；任何多租户表述都必须撤回。

## 5. 缺口清单（按是否需要先补测排序）

### 5.1 需要补测后才能关闭 G0

- **G-1 账号冲突与 SSO 域（C5）**：两账号同站点、允许域 + SSO 域组合，验证不隐式选“最新账号”、SSO 域不把另一账号带进来。影响：P3 设计（accountKey 与站点策略）。
- **G-2 `gateway_call` 策略读取（C9）**：在网关路径上验证策略层能拿到内层工具名并拒绝未授权工具，包含 `browser_cookie_list` 这类读凭据工具。影响：方案 3.1“两条路径不能绕过”。

### 5.2 实现期必须处理（不阻塞 P1）

- **G-3 下载完成判定**（C11/C12）：以目录 rename 为准，MCP 的 `Download is starting` 归为“已开始、待完成”，不得上报失败。
- **G-4 恢复闸门**（C3）：一次性 epoch + 仅缺键才播种；加载/刷新要能被显式触发并返回 revision。
- **G-5 写入鉴权**（C14）：`save` 走 `fs` 服务；拒绝覆盖、拒绝越权目标目录。
- **G-6 部署形态**：打包安装，工作树改动必须重新产出 tgz 并安装，不能假设重启即生效。
- **G-7 挂载一致**：禁止重建在用下载目录；迁移只复制不改绑定。

## 6. G0 判定

方案 8 节 G0 的四条放行条件：

| 条件 | 判定 | 依据 |
|---|---|---|
| 可信 scope 可验证 | **不满足** | 宿主无用户身份（C15），只能管理员白名单；多租户表述不可用 |
| 受支持登录态能在页面脚本之前恢复 | **满足** | C1–C4 实测通过（Cookie 首请求、localStorage 首脚本、登录后不回滚、重定向/新标签） |
| MCP/原生均无旁路 | **部分满足** | 直接 MCP 与原生路径可拦截（C7/C8）；`gateway_call` 待补用例（G-2） |
| 产物完成信号可靠 | **部分满足** | 下载有目录 rename 约定（C11）；MCP 产物只能扫目录（C10）；raw Playwright 路径语义不同（C12） |

**结论：G0 未全绿，按方案“先修订方案”的要求，暂不放行 P2/P3 的对外承诺。** 建议：
1. 先补 G-1、G-2 两条用例（成本低，均为虚构账号/虚构域）。
2. 同时启动 **P1 的池与存储底座**（全槽位独立、lease/回收状态机、map 迁移、scope resolver、认证仓库与产物仓库）——该阶段不依赖登录态恢复结论，可在 G-1/G-2 补齐期间并行。
3. 修订方案两处措辞：`scope` 只能声明为管理员白名单；MCP 下载的“错误”语义与 raw Playwright 的差异要写进验收项 A10。

## 7. 测试资源回收记录

- 容器 `neko-p0probe`：`docker rm -f` 已删除，未触碰 `neko`、`neko-obr47ww3`、`neko-9vnm9eh5` 等其他容器。
- 临时 HTTP 服务：`site.mjs`(38917)、`slow.mjs`(38918) 已停止。
- 宿主临时目录：`/tmp/p0`、`/tmp/p0pb`、`/tmp/p0-profile-*` 已删除；工作区 `.p0-out`、`.p0-home`、`.p0-browsers` 已删除。
- 仓库状态：除本文件与方案文档外无改动。

## 8. 补测（2026-11-10 第二轮）

### 8.1 G-1 账号与 origin 隔离

`scripts/p0-auth-isolation.mjs`（手动入口，非默认单元测试）：本机 Chrome、临时 profile、虚构站点，`127.0.0.1:38917` 与 `localhost:38917` 视为两个 origin。7/7 通过：

| 结论 | 证据 |
|---|---|
| Cookie 按 host 隔离，互不发送 | 两 host 各写同名 `acct_host`，各自只收到自己的值 |
| 两个账号在同一 host 无法共存 | 只追加 `sessionid` 时，上一账号的 `profile` cookie 仍在 jar 里 → 混合账号 |
| 恢复必须先清后写 | `clearCookies({domain})` 后再 add，jar 只含目标账号 |
| localStorage 按 origin 隔离 | 在 `localhost` 写入后，`127.0.0.1` 读到 `null` |
| 清理单个 host 不影响另一个 | 清 `localhost` 后 `127.0.0.1` 的 cookie 仍在 |

**对 P3 的硬约束**：恢复流程必须“清空目标 host 的 cookie → 写入快照 → 再写 localStorage”，否则会出现 A 账号 `sessionid` 与 B 账号其它 cookie 共存，正是 A04 要防的串号。SSO 域冲突仍需真实双域用例，本轮只证明了单 host 语义。

### 8.2 G-2 `gateway_call` 策略

新增 [lib/sharing/policy.js](../lib/sharing/policy.js)：把三条路径（native `browser_live_*`、直连 MCP、`browser_gateway_call`）统一分类，取 `arguments.tool` 里的真实工具名，拒绝嵌套网关元工具，并把凭据类工具（cookie/storage/`browser_live_state`）与普通浏览分开授权。`test/sharing-policy.test.mjs` 10 项通过：

- 网关调用按内层工具名分类（`browser_cookie_list` → credential=true），不是按 `browser_gateway_call` 分类；
- 缺 `tool`、嵌套 `browser_gateway_*` 一律判为 malformed 并拒绝；
- 非成员在三条路径上都被拒绝；成员无凭据授权时可浏览、不可读 cookie；
- 拒绝消息不回显参数里的 cookie 值。

**性质说明**：这是策略层的单元证据；端到端“网关路径实际被拦”要等协调器接入 `tools/execute` 后再做（P1 内），现有 14 项网关测试已证明 `browser_gateway_call` 的透传与参数形状。

### 8.3 运行参数决定（2026-11-10 用户确认）

| 参数 | 决定 | 实现落点 |
|---|---|---|
| 共享范围 | 所有会话与子代理 | `lib/sharing/scope.js`：单组 `trusted-group`，成员=任一活 agent，含子代理 |
| 网站范围 | 所有网站 | 站点策略允许任意 origin，仍按 origin 精确建键，不跨 origin 扩权 |
| legacy 槽位 | 退出新池 | `migrateMap()` 把 v1 的 legacy 条目移入 `retired`，容器只作迁移源保留 |
| 保留/配额 | 暂不自动删除（方案默认） | P1 只统计与告警，不删除 |

### 8.4 G0 复判

| 条件 | 判定 | 依据 |
|---|---|---|
| 可信 scope 可验证 | **满足（单组定义）** | scope resolver 有测试；身份仍是管理员白名单，不是多租户 |
| 登录态页面脚本前恢复 | **满足** | C1–C4 + G-1 |
| MCP/原生/gateway 无旁路 | **满足（策略层）** | G-2 单元证据；端到端拦截随 P1 协调器接入 |
| 产物完成信号可靠 | **部分** | 下载靠目录 rename；MCP 产物无 structuredContent（见 C10/C11） |

**G0 结论：三条满足、一条部分满足。** 产物信号的“部分”是已知实现约束（扫描 + rename 约定），不影响 P1 开工；P2 落地采集器时按该约定实现，并在 A10 里显式验收。


## 9. 第二轮收口后的能力状态（2026-11-10）

本节不重测 P0 探针，只记录第二轮代码对前述能力/缺口的落点与证据等级。证据等级：`E1`=真实后端/真实命令；`E2`=装配级单测；`E3`=纯逻辑单测；`未测`=本轮未执行。

| 能力/缺口 | 第二轮落点 | 证据等级 | 备注 |
|---|---|---|---|
| C1–C4 首请求恢复 | `coordinator.prepare({targetUrl})` 支持空白实例；init script 按 revision 追加、marker 播种后自毁 | **E1（2026-11-11 远端隔离）** | 空白 B 首段脚本观测到 `sid=WORK`/`pref=dark`；见 `docs/remote-acceptance-2026-11-11.md` |
| C5 账号/SSO 冲突 | `capture.selectCapture` + 绑定 `cookieDomains`/`ssoOrigins`；换号先清旧域与旧播种键 | E3 | SSO 真实双域待授权 |
| C9/C10 MCP 与 gateway | provider 对两条路径都取目标 URL；MCP 传会话级 `--output-dir` 并归集图片/PDF | E2 | 真实 MCP 待授权 |
| C11/C12 下载完成 | 采集器只认最终名；定时扫描（默认 60s）＋启动 marker 补偿＋回收前终采 | **E1（下载完成）+ E3（晚完成/重启）** | 远端真实下载落盘并发布；晚完成事件仍未测 |
| C14 写授权 | `export.js` 走 `fs.resolve/contains` + `fs/write-intent` + sandbox policy + `O_EXCL`；真实 `dsh-fs-local` 8 项通过 | **E1** | 宿主 0.2.1-rc.2 无二进制写 API，见 P2/P3 收口文档限制 |
| C15 身份 | 不改变：仍是管理员单组白名单 | — | 不宣称多租户 |
| C16 槽位 0 | P1 已取消 legacy 例外；新池槽位 0 独立容器/卷/viewer | **E1（远端单槽）** | A/B 串行各得独立容器/卷；并行/迁移对账待授权 |
| 配额 | `ArtifactStore(quotaBytes)` stage/publish 双窗口；默认 null | E3 | 达到配额停止发布、保留源、不删历史 |

**结论更新（2026-11-11）**：远端 `<remote-test-host>` 已完成真实浏览器/容器单场景（A 保存→B 首请求恢复→撤销→截图/下载回收后查询）9 步；A01 并行、A08 MCP/gateway、A10 晚完成、A12/A13 故障注入、A15 迁移回滚仍未执行，不能声称 G4 通过。
