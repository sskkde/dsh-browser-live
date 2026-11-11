# 跨会话共享第二轮 · 验证证据（2026-11-10）

- 基线：`f4d33e3`，包版本 0.8.0，`npm test` 126/126。
- 本轮后：包版本 0.9.0（工作树，未打包、未安装、未部署）；`npm test` 185/185。
- 环境：本机 Linux，Node `22.23.4`，Docker `29.9.2`（本轮未启动/停止任何容器）。
- 原始日志：`.evidence/npm-test-2026-11-10.log`（已在 `.gitignore`，不随仓库提交）。

## 1. 命令与结果

| 命令 | 退出码 | 结果 | 说明 |
|---|---|---|---|
| `git rev-parse HEAD` | 0 | `f4d33e3…` | 基线复核 |
| `git status --porcelain`（开工时） | 0 | 空 | 工作树干净 |
| `npm test`（开工时） | 0 | 126 pass / 0 fail | 基线 |
| `DSH_CHECKOUT=<harness-checkout> npm test`（收口） | 0 | **185 pass / 0 fail / 0 skipped** | 日志见 `.evidence/npm-test-2026-11-10.log`；未设 `DSH_CHECKOUT` 时真实 fs 的 8 项会 skip，不是通过 |
| `node --check` × `lib/index.js`、`lib/tools.js`、`lib/provider.js`、`lib/service.js`、`lib/sharing/*.js` | 0 | 全部通过 | 语法检查 |
| `node --test test/sharing-assembly.test.mjs` | 0 | 10 pass | 装配/工具/持久化 |
| `node --test test/pool-safety.test.mjs` | 0 | 13 pass | 池门禁 |
| `node --test test/sharing-export-integration.test.mjs` | 0 | 8 pass | **真实 `dsh-fs-local`** 授权路径 |
| `node --test test/artifact-quota.test.mjs` | 0 | 6 pass | 配额/崩溃对账 |
| `node --test test/sharing-coordinator.test.mjs` | 0 | 28 pass | 恢复时序 |
| `node --test test/sharing-collector.test.mjs` | 0 | 13 pass | 完成判定/类型过滤/纳秒 mtime |
| `node --test test/sharing-export.test.mjs` | 0 | 7 pass | 缺 sandboxPolicy 拒绝、no-follow 写入单测 |

本地测试阶段未操作 Docker/浏览器；随后按用户授权在远端 `<remote-test-host>` 执行了隔离真实浏览器验收（见第 8 节）。

## 2. 新增/修改测试覆盖

| 测试文件 | 覆盖点 |
|---|---|
| `test/sharing-assembly.test.mjs` | `apply()` 真实装配：先建 runtime 再建 provider、`browserLive.sharing.auth` 存在、provider 收到 coordinator、gate 以 `prepend` 安装、关闭时零行为；`browser_live_state` list/forget 走真实 AuthStore；撤销后迟到 save 被拒；`save`/`load` 经注册工具（虚构浏览器）返回 revision/epoch 并过滤站点外 Cookie；重启后 restore 记录从 journal 恢复并可清除活动实例；由 marker 触发的启动补偿采集 |
| `test/pool-safety.test.mjs` | 迁移备份 + legacy 只退休；释放后重分配 generation 递增；lease 延迟 release；容器重建 generation 递增；busy/lease 下 LRU 不误杀、槽位不复用；回收失败保留 deleting/lastError/retryAt；受管标签双向对账只报告；`beforeRelease` 终采；status 不分配、不启动、不刷新 `lastUsed` |
| `test/sharing-export.test.mjs` | 缺 sandboxPolicy 时拒绝写入（fail-closed） |
| `test/sharing-export-integration.test.mjs` | 真实 `@deepseek-ai/dsh-fs-local`：`fs/write-intent` 被调用；越界路径、已有文件、符号链接、read-only、workspace-write 越根、`replaceIfVersion` 全部拒绝；流式复制下载走同一门禁 |
| `test/artifact-quota.test.mjs` | 累计硬配额在 stage/publish 两个窗口生效且不删除历史；并发 stage 不超配额；reconcile 报告孤儿对象/缺失数据/孤儿 staging 且不删除 |
| `test/sharing-coordinator.test.mjs` | 空白实例按目标 URL 首请求恢复；无目标不猜 origin；显式 load 保留 marker 给下一次导航；init script 播种后自毁 marker；站点策略外 Cookie/origin 不恢复；撤销清理 live 实例；换号时旧 origin 未打开也保留清理记录与 marker |
| `test/sharing-collector.test.mjs` | 截图目录非图片只报告不发布；MCP 目录图片/PDF 发布、yml/log 跳过；文件身份用纳秒 mtime，区分同尺寸同毫秒重写 |

## 3. 未覆盖/待授权（不能算通过）

| 项 | 原因 | 需要的授权/资源 |
|---|---|---|
| A01/A02/A03/A04 真实浏览器首请求 | 需要隔离容器 + 虚构站点 | 第 6 节资源清单授权 |
| A08 直接 MCP / gateway_call 实际拦截 | 需要真实 MCP 服务器与容器 | 同上 |
| A09/A10 容器内下载、晚完成、跨会话查询 | 需要绑定下载目录与真实完成事件 | 同上 |
| A12 磁盘满/进程中断 | 需要可写满的临时卷/进程 kill | 同上（可先用 tmpfs 小卷） |
| A13 真实回收失败/端口复用 | 需要真实 nginx 与容器 rm 失败注入 | 同上 |
| A15 迁移/回滚演练 | 需要旧 map/旧 tgz/停旧容器 | 单独授权 |
| 生产部署后验证 | 需安装 0.9.0 并重启 | 生产切换单独授权 |

## 4. 脱敏说明

- 测试只用虚构站点 `example.test` / `app.example.test` / `evil.test` 和虚构 Cookie 值。
- 测试日志无真实凭据；`test/sharing-assembly.test.mjs` 的 state 列表断言额外检查了响应中不出现 Cookie 名值原文。
- 未读取/复制 `~/.dsh` 下真实 states、产物或分享数据。
- 真实 `dsh-fs-local` 集成测试只写入 `mkdtemp` 临时目录，结束后由系统临时目录清理；未写入用户工作区之外。

## 5. 本轮修改文件

- `lib/index.js`、`lib/tools.js`、`lib/provider.js`、`lib/service.js`
- `lib/sharing/coordinator.js`、`lib/sharing/collector.js`、`lib/sharing/export.js`、`lib/sharing/artifact-store.js`、`lib/sharing/capture.js`（新增）
- `test/sharing-assembly.test.mjs`、`test/pool-safety.test.mjs`、`test/sharing-export-integration.test.mjs`、`test/artifact-quota.test.mjs`（新增），`test/sharing-coordinator.test.mjs`、`test/sharing-collector.test.mjs`（扩充）
- `docs/sharing-followup-plan.md`、`docs/verification-2026-11-10-sharing-followup.md`（新增）
- `package.json` 版本 0.9.0、`.gitignore` 增加 `.evidence/`

## 6. 独立只读复核与处置

复核方式：独立只读子代理审阅工作树（不改文件、不起容器），另由主控跑全量测试。复核提出的阻断/高危项与处置：

| 复核项 | 处置 | 验证 |
|---|---|---|
| `load` 可用显式账号绕过 origin 绑定 | 显式账号必须与 origin 绑定一致；不一致返回 `account-not-bound`；未绑定 origin 不允许恢复 | coordinator “explicit account must be the admin-bound account” |
| 同 epoch 新 revision 的 marker 冲突；旧 localStorage 值残留 | marker 值改为 `epoch:revision`；init script 改为覆盖写入；换号/刷新先清旧播种键 | VM 执行 script：只消费一次、覆盖旧值、登出后不回灌、旧 revision 脚本不消费新 marker |
| 直接工具不导航时 marker 被提前清掉，首段 localStorage 丢失 | 页面已在该 origin 时直接写入 localStorage；只有仍需导航的 origin 才留 marker，`finish` 不提前清除 pending marker | 显式 load 的 pending marker 测试；已打开页面直写测试 |
| 撤销时 origin 不在当前页面，localStorage 未清却报成功；deleting 实例记录被删 | 返回 `localstorage-origin-not-open` 并保留 journal；`deleting` 返回 `browser-reclaiming`；只有确认无实例才删记录 | 两个新增 coordinator 用例 |
| 导出先 mkdir 后授权、缺 ctx 时 fail-open、父目录符号链接 TOCTOU | 授权（lexical sandbox + write-intent）先于 mkdir；缺 ctx 直接拒绝；通过 no-follow 父目录 fd + `/proc/self/fd` 打开目标并二次校验 realpath | 真实 fs 集成：read-only 拒绝且不建目录、父目录符号链接拒绝、缺 ctx 拒绝 |
| Docker inspect 错误被当作容器不存在 | 仅 “No such container/object” 判 absent；其他错误保留条目与槽位并报错 | `pool-safety` “inspection failure is not absent” |
| nginx 目录不可读被当作清理成功 | 区分 `no-nginx`/`no-vhost`/`unreadable`；unreadable 返回失败并保留 deleting | 代码路径；真实 nginx 失败注入待授权 |
| 并发 stage 共享配额快照 | 有硬配额时串行化 stage；并发用例一个成功一个 `QUOTA`，staging 不超配额 | `artifact-quota` 并发用例 |
| MCP 文件仍在写就被发布 | stage 后再次 stat，size:mtime 变化则 discard 并记失败 | collector “file grows while read” 用例 |
| 定时器关闭时 MCP 调用不采集 | provider 在每次 MCP 调用 finally 触发 `sharing.collect` | 代码路径；真实 MCP 待授权 |
| SSO origin 读不到 origin host 的 marker | 每个仍待播种的 origin 各写一份 host marker（含 SSO） | 新用例检查 marker host 集合 |

**复核后仍属“代码路径/未测”的项**：真实 MCP 服务器参数与恢复执行、真实 nginx 删除失败/端口复用、Docker inspect 中断后的现场恢复、导出父目录替换竞态的对抗性实验、并发 stage 的磁盘满场景、stage/publish 交错时的配额对抗实验。上述均未计为通过。

## 7. 第二轮复核残余处置（2026-11-11）

| 残余 | 处置 | 验证 |
|---|---|---|
| `save` 允许未绑定 origin，按调用方给的账号发布 | 未绑定 origin 直接拒绝，要求先加 `sharing.bindings` | 装配测试：未绑定 runtime 的 save 报 `is not bound to an account` |
| 换号时旧 origin 页面不在，旧 localStorage 清理丢失、journal 被新快照覆盖 | `clearSeededKeys` 返回未清 origin；这些 origin 也装 marker；记录 `pendingCleanupKeys`，`clearRestored` 同时清两份键表 | 新 coordinator 用例：旧 origin 不在页面时保留 `{"https://example.test":["pref"]}` 与两个 host marker |
| 缺 `sandboxPolicy` 时导出仍放行 | 缺 policy 视为不可授权，直接拒绝；仅显式 `danger-full-access` 放行 | 新 export 用例报 `sandbox policy is unavailable`；真实 fs 集成仍走显式 policy |
| stopped 容器 `docker rm` 失败仍删 map / 继续 start | `ensure` 失败保留条目并报错；启动接管与 adopt 的 stopped 分支同样保留 | 新 pool 用例：rm 失败后 map 条目与 `lastError` 仍在 |
| `publish` 的配额检查与提交不在同一临界区 | 有硬配额时 `publish` 与 `stage` 共用 `__quota__` 锁，检查+提交串行 | 代码路径；并发交错对抗未测 |
| collector 文件身份只有 size+毫秒 mtime | 使用 BigInt `mtimeNs`（纳秒）参与 key | 新 collector 用例区分同尺寸同毫秒 |
| journal 持久化失败仍静默 | 保留为已知限制：写失败时内存记录仍生效，但重启后清理记录可能丢失 | 未修；列入剩余缺口 |
| 同一 host 不同 scheme/port 的 marker 共享 | 保留为已知限制：SSO origin 需使用不同 host；同 host 多端口不保证各自首导航播种 | 未修；文档限制 |


## 8. 远端隔离验收（2026-11-11）

按用户授权在 `<remote-test-host>` 一次性环境执行，详见 [remote-acceptance-2026-11-11.md](remote-acceptance-2026-11-11.md)。

- 真实 DSH runtime 0.2.1-rc.2、插件 0.9.0、Docker 29.9.2、Neko/Chromium 容器、虚构站点 `127.0.0.1:38931`。
- 9 步全部 PASS：A 保存登录态/截图；A 释放后 status 不分配；空白 B 首请求恢复 Cookie+localStorage；B 下载并发布；撤销后活动实例清理且不回灌；B 释放后产物仍可查询。
- 发现真实缺陷：Playwright `connectOverCDP` 默认改写下载目录；已用 `{ noDefaults: true }` 修复并补本地断言；首轮失败证据与复测证据均归档。
- 未测：完整 DSH Web/agent、MCP screenshot/PDF 与 gateway_call、nginx 查看器、远端导出、配额磁盘满/TTL/迁移回滚。
- 清理：精确容器/卷/镜像/进程/运行根已删除；既有 `<existing-container>` 与其他 `dsh-test` 目录未动；端口释放；未做全局 Docker prune。
