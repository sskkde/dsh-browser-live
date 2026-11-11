# 跨会话共享 · 收口实施计划（2026-11-10 第二轮）

- 基线：`master` @ `f4d33e3`（`246c0bd` v0.8.0 后仅新增交接文档），工作树干净；`npm test` 126/126 通过。
- 当前 profile 安装副本：`file:<artifacts>/dsh-browser-live-0.5.0.tgz`（0.5.0，不是工作树）。
- 共享开关：生产/当前 profile 仍是 `sharing.enabled=false`；本轮不修改 profile、不重启、不热重载、不启用生产共享。
- 本文件是实施计划与验收追踪表，不是“已完成”声明。状态列只认实际命令输出与证据路径。

## 1. 基线复核结论

| 项 | 复核结果 | 依据 |
|---|---|---|
| HEAD | `f4d33e3` | `git rev-parse HEAD` |
| 包版本 | 0.8.0 | `package.json` |
| 工作树 | 干净 | `git status --porcelain` |
| 测试 | 126 pass / 0 fail | `npm test`（2026-11-10 本轮） |
| 运行实例 | 0.5.0 tgz 副本 | `~/.dsh/profiles/web/package.json` |
| Docker | 29.9.2，存在 `neko`、`neko-obr47ww3`、`neko-9vnm9eh5` 等真实容器 | `docker ps -a`（只读） |

## 2. 本轮已确认缺陷（源码级，非文档表述）

| ID | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| D1 | 共享运行时没有把 `auth` 放进 `browserLive.sharing`；state save/list/forget 访问 `sharing.auth` 必然 TypeError | `lib/index.js:168`、`lib/tools.js:211-305` | P3 显式保存/列出/撤销全断 |
| D2 | `applyProvider` 在 `sharingRuntime` 赋值前调用，`coordinator` 恒为 `undefined` | `lib/index.js:108-114`、`169` | 直接 MCP / `gateway_call` 完全不做恢复 |
| D3 | 恢复 origin 只从“已打开页面”推导，空白实例返回 `no-navigated-page` | `lib/sharing/coordinator.js:84-91,104-105` | B 实例首次导航无法恢复（核心 G3 阻断） |
| D4 | `save` 抓取整个 context 的全部 Cookie 与所有已打开 origin 的 localStorage，却按第一个 origin 建 revision | `lib/tools.js:247-281` | 串站点/串账号入库，越过 A04/A07 边界 |
| D5 | init script 只安装一次（`instrumented` WeakSet），刷新/换 revision 后新 payload 不生效；marker 只在工具调用结束撤销，单次调用内登出后再次导航会被回灌 | `lib/sharing/coordinator.js:139-149,169-175` | 显式刷新无效；登出后回灌旧快照 |
| D6 | `forget` 只写 tombstone，不处理已导入的活动实例；恢复记录不保存 accountKey/siteKey | `lib/tools.js:234-245`、`coordinator.js:150` | 撤销后活动实例仍带着旧凭据 |
| D7 | `browser_live_status` 走 `ensure()`＋`withSession`，会分配槽位、触发恢复、刷新 `lastUsed`；artifact 查询不拉起浏览器但状态查询会 | `lib/tools.js:655-677` | 违反“查询不拉起浏览器/不刷新空闲” |
| D8 | 工具返回不含 revision/epoch/冲突详情 | `lib/tools.js:211-305` | 调用方无法判断 CAS/撤销结果 |
| D9 | `allocate` 的 LRU 只传 `leased`，未把 `agentBusy` 传入；真实调用与纯 helper 能力不一致 | `lib/service.js:368` | 可能在 turn 中回收浏览器 |
| D10 | `#finishEviction` 吞掉 nginx 删除失败并删除 map 条目；槽位被复用后旧路由可能指向新容器端口 | `lib/service.js:436-452,917-922` | 旧入口残留 / 路由串号 |
| D11 | `generation` 每次重建固定为 1；map 条目删除重分配后 generation 复位 | `lib/service.js:359-360,382-394` | coordinator 的 `instanceKey` 无法区分重建实例，恢复被跳过 |
| D12 | 无受管标签、无 map↔docker 双向对账；map 迁移无备份 | `lib/service.js:622-671,972-1021` | 未知/孤儿容器不可见；旧代码回滚边界不清 |
| D13 | `release` 未检查 lease，activation dispose 可在在途操作中回收 | `lib/service.js:459-464`、`provider.js:347-351` | 在途操作被打断 |
| D14 | MCP 未设置会话级 `--output-dir`，截图/PDF 不进入共享库 | `lib/provider.js:316-324`、`gateway` 内层 spawn | P2 MCP 归集缺口 |
| D15 | 归集只在浏览器工具调用结束时触发；无定时/启动补偿；归集失败被 `void … .catch(() => undefined)` 吞掉 | `lib/index.js:152-167`、`lib/tools.js:194-196` | 晚完成下载/闲置下载丢失，失败不可见 |
| D16 | 产物导出用 `fs.open` 裸写，未调用 `fs/write-intent`、未按 sandbox policy 拒绝越权目标 | `lib/sharing/export.js:44-51` | C14/A11 未闭环 |
| D17 | 产物库无累计硬配额；`stats()` 只统计不判定 | `lib/sharing/artifact-store.js` | G2 配额门禁缺失 |
| D18 | 截图目录扫描不区分类型，非图片文件也会当 screenshot 发布 | `lib/sharing/collector.js:141-145` | 与“仅标注已验证类型”不符 |

## 3. 实施步骤（按依赖顺序）

### 阶段 A：P3 确定性接线（阻断项，先做）

1. 重组 `lib/index.js`：先建 sharing runtime（scope/auth/store/audit/coordinator/collect），`browserLive.sharing = { auth, coordinator, scope, store, audit, collect, … }`，再 `applyProvider(..., { coordinator })`，最后注册工具；保留 `sharing.enabled=false` 时零行为的语义。
2. coordinator 接受显式目标：`prepare({ targetUrl?, targetOrigin? })`；无已打开页面时用目标 origin；仍无目标才返回 `no-target-origin`。
3. 原生路径把本次 URL 传入（open/fetch/script/recipe 的 `url` 参数）；MCP 路径从 `exec.arguments.url`（含 `browser_gateway_call.arguments.arguments.url`）提取，首个 `browser_navigate` 在请求前恢复。
4. init script 改为“按 revision 追加 + marker 用后即焚”：每次恢复追加带当前 epoch 的脚本；脚本播种后立即让 marker 过期；不再用 `instrumented` 阻断后续 revision。
5. `save` 的范围校验：`siteKey=主页面 origin`；只收 host 匹配的 Cookie（精确 host，SSO 域名需绑定显式声明）；localStorage 只收 `{siteKey} ∪ ssoOrigins`；其余记录为 skipped；账号与现有绑定冲突时拒绝。
6. `forget`：写 tombstone 后，对 coordinator 记录中同 `siteKey+accountKey` 的活动实例逐个 attach，清 cookie/localStorage/marker，再清除记录；返回 epoch 与处理结果。
7. 工具返回 revision/epoch/currentRevision；`RevisionConflictError` 转成带 `current` 的可读冲突错误。
8. `browser_live_status` 改为只读 map/容器状态：无条目不分配；不恢复；不更新 `lastUsed`；仅当容器已运行才 attach 读标签页。

### 阶段 B：P1 资源池安全门禁

1. `allocate` 把 `busy`（agent 正在 turn）与 `leased` 同时交给 `pickEvictionCandidate`。
2. `release` 延迟到最后一个 lease 结束；lease 释放回调里执行挂起的回收。
3. 回收状态机：删除失败/nginx 删除失败都保留 `state=deleting`、`lastError`、`retryAt`，槽位不复用；sweep 重试；只有容器与入口都确认释放才删条目。
4. 实例化 generation：`map.containerGenerations[short]` 持久计数，每次容器重建/重分配 +1；写进 entry 与 docker label。
5. 容器标签：`dsh.browser-live.managed=true`、`session`、`generation`；新增 `reconcile()` 双向对账，未知/孤儿只报告；启动时调用。
6. map 迁移前备份 `neko-browser-live.map.json.v<old>.bak`；legacy 条目继续只进 `retired`，不删容器/卷。
7. 回收前触发 `browserLive.beforeRelease` 钩子（最后一次产物采集），钩子失败不阻塞回收但记录。

### 阶段 C：P2 共享文件闭环

1. MCP 启动参数加会话级 `--output-dir <session dir>/mcp`（直连与 gateway 内层两条 spawn 都加），归集扫描该目录的图片/PDF。
2. 采集器：类型推断（图片=screenshot、PDF=pdf、其他=download），截图目录非图片不自动发布；单文件同步发布函数返回 `artifactId/published/error`，原生截图响应增加可选字段。
3. 定时采集（默认 60s，可配 0 关闭）＋启动补偿＋回收前终采；每个会话串行；失败写入诊断（`lastCollect`）并在工具响应/状态中可见。
4. 产物导出：`fs.resolve`＋`contains`＋`lstat/stat`＋`fs/write-intent` waterfall＋sandbox policy 判定（read-only 拒绝；workspace-write 要求 realpath 在 workspaceRoot 下）＋`O_EXCL|O_NOFOLLOW` 原子写＋fsync；失败明确返回，不回退裸拷贝。旧 `browser_live_download save` 也走同一写入器。
5. ArtifactStore：累计硬配额（配置 `quotaBytes`，默认 `null` 不改变现有保留策略）；达到配额时拒绝新发布、保留源文件、不删历史；`reconcile()` 报告孤儿 staging/对象/缺失对象。
6. 文档标注已验证类型：图片、PDF、普通下载文件；tracing/video 明确不在“截图等价”范围。

### 阶段 D：测试与证据

1. 先补失败回归（缺陷→红），再修复转绿。
2. 装配级测试（不依赖 Docker）：`apply()` 用测试依赖注入验证 sharing 装配、工具注册、provider 收到 coordinator；`browserLive.sharing.auth` 存在；state save/list/forget/load 走真实 AuthStore（临时目录）。
3. 协调器测试：空白实例首导航目标恢复、marker 用后即焚、revision 切换、撤销、换号清理域、登出后不回灌。
4. 池测试：busy+lease 的真实 allocate、延迟 release、nginx/容器删除失败保留、generation 递增、标签/对账、迁移备份。
5. 导出测试：真实 `dsh-fs` 前端（local backend）集成＋write-intent 拒绝、越权、符号链接、竞态、覆盖拒绝；用 fakeFs 只能作为补充，不作为授权证明。
6. `npm test`、`node --check`、脱敏日志保存到 `docs/` 或 `.evidence/`（不提交敏感内容）。

### 阶段 E：隔离验收（需单独授权）

- 资源清单与清理清单见第 6 节；未获授权前不启动任何容器/浏览器测试。
- 通过后更新能力矩阵、交接文档、迁移/回滚记录。

## 4. 验收追踪表（G0–G4 / A01–A16）

状态定义：`通过`=有本次命令与证据；`失败`=有反证；`未测`=未执行；`待授权`=需要用户授权的隔离资源；`未实施`=代码尚缺。**“未测/待授权/未实施”不计通过。**

| ID | 场景 | 对应实现 | 本轮验证方式 | 当前状态 |
|---|---|---|---|---|
| G0 | 可信 scope、首请求恢复、三路径无旁路、产物信号 | scope/policy/gate/coordinator | 策略/装配单测 | 策略与装配通过；真实三路径待授权 |
| G1 | 独立池、无 legacy 串用、busy 不淘汰、回收不丢追踪 | service.js | `pool-safety` 13 项；远端真实容器单槽 | 单测通过；远端单槽通过；多槽/回收实机未测 |
| G2 | A 生成 B 读取/保存、同名/半下载/穿越/配额/重启补偿 | collector/artifact/export | `artifact-quota` 6、`sharing-export-integration` 8、`sharing-assembly` 补偿 1；远端真实截图/下载 | 存储/导出/补偿单测与真实 fs 通过；远端原生截图/下载通过；MCP 待测 |
| G3 | 首请求 Cookie+localStorage、A/B 独立、换号/撤销安全 | coordinator/tools | coordinator 28、assembly 10；远端真实 A/B | 装配/时序单测通过；**远端空白 B 首请求恢复与撤销通过** |
| G4 | 全量矩阵、迁移/回滚演练、无残留 | 全部 | 远端单场景 9 步 | 部分通过；全量/MCP/迁移/回滚仍未测 |
| A01 | A/B 并行独立浏览，槽位 0 无例外 | service.js | 远端 A/B 串行（单槽） | 串行通过；并行未测 |
| A02 | B 首请求即恢复，不用第二次刷新 | coordinator | 单测＋远端空白 B 首脚本回传 | **通过（远端）** |
| A03 | 新页/302/SSO 注入边界，不反复回写 | coordinator | marker 自毁、按 epoch 脚本、策略过滤单测 | 单测通过；浏览器待授权 |
| A04 | 两账号/Cookie 域冲突不串号 | capture＋coordinator | `selectCapture` 冲突/域过滤、换号清理域 | 单测通过；浏览器待授权 |
| A05 | 并发发布只有一个成功，冲突可见 | AuthStore CAS＋工具返回 | 迟到 save 拒绝、冲突错误含 current revision | 单测通过 |
| A06 | 过期/退出/撤销，epoch 阻止迟到提交 | AuthStore＋forget＋journal | 单测＋远端 forget 清活动 B | **通过（远端撤销场景）**；重启 journal 未测 |
| A07 | scope/子代理/伪造参数拒绝 | scope/policy/gate | policy 10、gate 8 | 策略层通过；端到端待授权 |
| A08 | 直接 MCP 与 gateway_call 与原生一致 | provider/policy | apply 装配断言 coordinator 注入、`targetUrlForCall` 含 gateway | 装配/选择器通过；真实 MCP 待授权 |
| A09 | 下载/截图跨会话，容器回收后仍可读 | collector/store | 单测＋远端真实截图/下载回收后查询 | **部分通过（远端原生路径）**；MCP 未测 |
| A10 | 同名/半下载/晚完成补入库 | collector＋定时器＋启动补偿 | 类型/完成判定、marker 启动补偿 | 单测通过；晚完成浏览器事件待授权 |
| A11 | 路径/文件名/穿越/符号链接/覆盖拒绝 | export | 真实 `dsh-fs-local` 6 项 | 通过（真实 fs 后端） |
| A12 | 崩溃/磁盘满/重启，无半个对象 | artifact-store | 配额窗口、reconcile 孤儿/缺失 | 存储单测通过；磁盘满现场待授权 |
| A13 | busy 池满/回收失败保留追踪 | service.js | pool-safety：lease 延迟、失败保留、槽位不复用 | 单测通过；真实容器待授权 |
| A14 | TTL 后凭据/文件仍可用 | service/sharing 分离 | 存储/池单测＋远端回收后文件查询 | 文件部分通过；TTL 未测 |
| A15 | 旧响应兼容、停用共享与回退旧 map | tools/service | 旧字段保留、迁移备份单测 | 单测通过；回滚演练待授权 |
| A16 | URL 脱敏、日志无凭据、只清理本次资源 | audit/文件权限 | 单测＋远端虚构站点/精确清理 | 部分通过；审计日志与凭据扫描未做 |

## 5. 授权边界（本轮）

- 允许：本地源码、测试、文档修改；`npm test`；`node --check`；临时目录内的存储/导出测试。
- 需单独授权：启动/停止任何 Docker 容器、挂载卷、端口/路由、真实浏览器会话、真实 DSH profile 变更、tgz 打包安装、重启/热重载。
- 2026-11-11 已获用户授权，在远端 `<remote-test-host>` 执行一次隔离验收（运行根 `<test-root>`），已按精确资源释放；记录见 [remote-acceptance-2026-11-11.md](remote-acceptance-2026-11-11.md)。再次执行仍需新授权。
- 禁止：修改当前生产 profile、启用生产共享、停止/删除既有 `neko*` 容器与卷、使用真实账号/凭据、全局 prune、按名称前缀批量删除、提交/推送/发布。

## 6. 隔离浏览器/容器测试资源清单（本地计划；远端实际记录见 remote-acceptance 文档）

命名前缀固定 `dshbltest-`，全部独立于真实会话：

| 资源 | 计划值 | 清理方式（只删本次精确对象） |
|---|---|---|
| DSH_HOME | `/tmp/dshbltest-home` | `rm -rf /tmp/dshbltest-home`（确认路径后） |
| 容器 | `dshbltest-neko-a`、`dshbltest-neko-b` | `docker rm -f dshbltest-neko-a dshbltest-neko-b` |
| 卷 | `dshbltest-profile-a/b` | `docker volume rm dshbltest-profile-a dshbltest-profile-b` |
| CDP/Web 端口 | 9391/9392、8391/8394（先探测空闲） | 容器删除即释放 |
| 虚构站点 | `127.0.0.1:38931`（首脚本读状态、302、下载、登录页） | 停止本次 node 进程 |
| 入口路由 | 不写入系统 nginx；测试实例 `provision:false` | 无需清理 |
| 产物 | `/tmp/dshbltest-home/data/browser-live/**` | 随 DSH_HOME 删除 |

清理只按上表精确名字执行；禁止 `docker prune`、禁止按 `neko-` 前缀匹配（真实容器同前缀）、禁止删除 <repo> 之外不属于本次的目录。

## 7. 迁移/回滚要点

1. 首次写入 v2 map 前，把原文件复制为 `neko-browser-live.map.json.v1.bak`（0600），并记录哈希。
2. legacy 条目：只进 `retired`，容器/卷/端口保留；新代码不启动它、不删除它。
3. 回滚：停用 sharing → 暂停新分配、排空在途操作 → 恢复备份 map → 安装旧版 tgz → 重启 → 浏览器工具回归。旧代码不得读取新版 map 的 `deleted`/`retired` 语义；共享仓库只读保留。
4. 共享撤销：写 tombstone 递增 epoch → 清活动实例导入状态 → 提示用户在网站端另行全端登出（不承诺服务器端失效）。

## 8. 完成判定

- 本地开发收口：D1–D18 修复、回归与装配测试通过、真实 fs 导出集成通过、独立只读复核无阻断、文档一致。
- 隔离验收：第 6 节授权后执行，A01–A04/A08–A14 逐项留证。
- 上线：需生产切换单独授权；本轮不宣称“方案全部完成或已生效”。
