# 交接文档：dsh-browser-live 跨会话共享（2026-11-10）

> 给下一个接手的会话／人：先读本文件，再读 `docs/p0-capability-matrix.md`、`docs/p1-sharing-baseline.md`、`docs/p2-p3-sharing-closeout.md`。方案原文是 `docs/cross-session-sharing-plan.md`。本文件记录的是**事实与状态**，不是计划。

## 0. 一句话

按方案实现了“独立浏览器 + 共享登录态仓库 + 共享文件库”的代码路径（P0 探针 → P1 底座 → P2 产物 → P3 登录态）。第二轮收口修复了 P3 的装配/首导航/撤销阻断与 P1/P2 的确定性门禁，**185 项测试全绿**；远端 `<remote-test-host>` 隔离真实浏览器单场景 9 步通过；但**生产运行实例仍是旧的 0.5.0，共享功能默认关闭，完整 Web/MCP/迁移验收未完成**。本文件的状态是历史快照，最新差异以 `docs/sharing-followup-plan.md` 与 `docs/verification-2026-11-10-sharing-followup.md` 为准。

## 1. 当前状态

| 项 | 值 |
|---|---|
| 远端/本地 HEAD（本轮开工） | `f4d33e3`（`v0.8.0` 后仅新增交接文档） |
| 提交序列 | `63c76e8` v0.5.1 → `ccd4a69` v0.6.0 → `f8720bc` v0.7.0 → `246c0bd` v0.8.0 → `f4d33e3` 交接文档 |
| 工作树（第二轮后） | 有未提交改动：P3/P1/P2 收口修复 + 新增测试/文档，包版本 0.9.0；**未提交、未推送、未安装** |
| 测试 | `node --test "test/**/*.test.mjs"` → 185 通过（本轮新增 59） |
| 运行实例 | **0.5.0**，由 `<artifacts>/dsh-browser-live-0.5.0.tgz` 装进 profile，是副本，不链接工作树 |
| 共享开关 | `sharing.enabled: false`（默认），gate 不安装，行为与改造前一致 |
| 数据 | 未迁移、未写入任何真实凭据或产物 |

## 2. 交付物地图

| 位置 | 作用 | 测试 |
|---|---|---|
| `docs/cross-session-sharing-plan.md` | 方案原文（用户批准的路线与 16 项验收矩阵） | — |
| `docs/p0-capability-matrix.md` | P0 能力矩阵、16 条事实（C1–C16）、G0 判定、G-1/G-2 补测 | — |
| `docs/p1-sharing-baseline.md` | P1 模块不变量、开关、测试清单 | — |
| `docs/p2-p3-sharing-closeout.md` | P2/P3 行为表、已知缺口 | — |
| `lib/service.js` | 池：全槽位独立、map v2 迁移、回收状态机、lease、容量错误 | `test/pool.test.mjs` 10 |
| `lib/sharing/scope.js` | scope 解析（活 agent → 单组） | 7 |
| `lib/sharing/policy.js` | 三条工具路径统一分类（含 gateway_call 内层工具名） | 10 |
| `lib/sharing/gate.js` | `tools/execute` 前置闸门 | 8 |
| `lib/sharing/auth-store.js` | 登录态 revision：CAS、撤销 epoch、原子写、0700/0600 | 9 |
| `lib/sharing/artifact-store.js` | 产物对象：不可变、metadata-last、可重建索引 | 15 |
| `lib/sharing/audit.js` | 脱敏追加审计 | 5 |
| `lib/sharing/coordinator.js` | 恢复：清域 → 写 cookie → 一次性标记 → 播种 localStorage | 12 |
| `lib/sharing/collector.js` | 完成判定 + 索引 + 发布 | 9 |
| `lib/sharing/export.js` | 受控导出到工作区 | 5 |
| `lib/tools.js` | 新增 `browser_live_artifact`；`browser_live_state` 双模式；租约/采集接线 | `recipe-steps` 10 |
| `lib/provider.js` | 准入自愈（v0.5.1）、MCP 路径租约与恢复 | `provider-admission` 12 |
| `scripts/p0-auth-isolation.mjs` | G-1 手动探针（需本机 Chrome） | 7/7 |

## 3. 已拍板的关键决策（2026-11-10，用户确认）

1. **共享范围**：所有会话与子代理（实现为单组 `trusted-group`，成员 = 任一活 agent；不是多租户隔离）。
2. **网站范围**：所有网站；实现仍按 **origin 精确建键**，不跨 origin 扩权。
3. **legacy 槽位**：退出新池；`migrateMap()` 把 v1 legacy 条目录入 `retired`，容器只作迁移源保留，不删除。
4. **保留策略**：不自动删除；配额只告警。
5. **自动发布**：未实现，且默认不开启（方案要求按站点正向登录校验后才允许）。
6. **共享默认关闭**：`sharing.enabled=false` 时 gate 不安装，行为与改造前完全一致。

## 4. 架构要点（改动时先看这里）

- **池**：每个槽位独立容器/卷/viewer；端口 CDP `9300+slot`、Web `8300+2*slot`、mux `52200+/52210+`，与 legacy 的 9222/8080/52100/52101 不重叠。`map` 版本 2，带 `generation` 与 `state`（`active|deleting`）。
- **回收**：`active → deleting → released`；容器真正消失前槽位不复用；删除失败保留条目与 `lastError` 等下次重试；lease 期间 TTL/LRU 不淘汰；池满全忙返回 `BrowserLiveCapacityError`（调用方重试即可）。
- **三条工具路径**：`browser_live_*`（原生）、`mcp__playwright-mcp__browser_*`（直连）、`mcp__playwright-mcp__browser_gateway_call`（内层工具名在 `arguments.tool`）。三者都先过 sharing gate，再进 provider 准入。
- **恢复时序**（coordinator）：清目标域 cookie（含上次恢复触及的域）→ 写 revision cookie → 写一次性 `__dsh_restore_marker=<epoch>:<revision>` → 装 init script 播种 localStorage；下一次调用撤标记，之后导航不再播种。
- **产物时序**（collector）：Chromium 先写 `Unconfirmed *.crdownload`，完成后 rename；扫描只认最终文件，按 `size:mtime` 索引去重，失败不影响工具结果。

## 5. 部署与生效（最容易踩的坑）

工作树改动**不会**自动进入运行实例。运行中的插件是 tgz 安装副本，重启只是重新加载那个副本。要让改动生效：

1. `npm pack` 产出 `dsh-browser-live-<version>.tgz`；
2. 复制到宿主上的升级产物目录（当前配置为 `file:<artifacts>/dsh-browser-live-0.5.0.tgz`，装新版要同步改 profile `package.json` 的依赖路径）；
3. 在 profile 里安装该 tgz（`npm install <tgz>`），确认 `node_modules/dsh-browser-live` 被替换；
4. 重启 harness（重启会中断所有会话当前回合；热重载会重建池与 MCP 客户端，不推荐在有人用浏览器时做）。

配置示例（只在需要时启用）：

```yaml
sharing:
  enabled: true
  scopeId: trusted-group
  allowCredentials: true
  members: []                 # 空 = 所有会话与子代理
  quotaBytes: null            # 未设置 = 不自动删除、只告警；设置后达到即停止新发布
  artifactScanIntervalMs: 60000   # 晚完成下载/截图的定时采集；0 关闭
  bindings:
    - origin: https://example.test
      accountKey: work
      # cookieDomains: [example.test]          # 显式允许的父域/SSO Cookie 域
      # ssoOrigins: [https://sso.example.test] # 显式允许的 SSO localStorage origin
```

启用后数据落在 `<DSH_HOME>/data/browser-live/shared/v1/scopes/<scopeId>/{auth,artifacts,audit}/`。

## 6. 验证

```bash
DSH_CHECKOUT=<harness-checkout> node --test "test/**/*.test.mjs"      # 185 项；未设时真实 fs 的 8 项 skip
node scripts/p0-auth-isolation.mjs    # G-1 探针：需要本机 /usr/bin/google-chrome
```

**远端已完成**：真实浏览器 + 虚构站点上的空白 B 首请求恢复（A02）、撤销清理（A06）、截图/下载采集与回收后查询（A09 原生路径）。**尚未做**：A01 并行、A03 302/SSO、A04 两账号冲突、A08 真实 MCP/gateway、A10 晚完成、A12 崩溃/磁盘满、A13 busy 池满、A14 TTL、A15 迁移与回滚。

## 7. 已知缺口（第二轮后）

1. **隔离浏览器/容器验收**：远端 `<remote-test-host>` 已执行首请求恢复/撤销/截图/下载 9 步（见 `docs/remote-acceptance-2026-11-11.md`）；A01 并行、A08 MCP/gateway、A10 晚完成、A12/A13 故障注入仍未执行。
2. **故障注入的现场半**：磁盘满、真实容器删除失败、nginx 删除失败重试只有单测/逻辑覆盖，没有真实宿主演练。
3. **迁移演练**：v1 map → v2 的真实容器对账、legacy 容器停用与回滚演练未做（代码已在迁移前备份 `.v1.bak`，legacy 只进 `retired`）。
4. **自动发布**：按站点开启 + 正向登录校验，未实现（默认关闭）。
5. **客户端 UI**：共享范围、绑定账号、待重新登录的展示，未做。
6. **生产部署**：0.9.0 未 `npm pack`、未安装、未重启。

## 7.1 第二轮已修复（相对第一版交接）

- `browserLive.sharing` 现在包含 `auth`；provider 在 sharing runtime 之后挂载并收到 coordinator（直接 MCP/gateway 恢复分支真实可达）。
- 首导航恢复按本次目标 URL 解析 origin，空白实例可用；init script 按 revision 追加、marker 播种后自毁；显式 load 的 marker 留给下一次导航。
- `save` 按“可见标签 origin + 绑定账号 + cookieDomains/ssoOrigins”过滤，不再整 context 入库；账号冲突拒绝。
- `forget` 同时清理活动实例，并把 restore 记录持久化到 `coordinator.json`（无 Cookie 值），重启后仍可清。
- 池：LRU 同时考虑 busy+lease；release 在 lease 结束后执行；回收失败保留 deleting/retryAt；generation 持久递增；受管标签与 map 双向对账只报告；迁移前备份 map；回收前终采；Docker inspect 非“容器不存在”错误保留条目/槽位，nginx 目录不可读不清路由。
- 独立复核后补：显式账号不得绕过 origin 绑定；marker 按 `epoch:revision` 区分；页面已打开时直接写 localStorage，pending marker 不再被 finish 提前清除；撤销无法清 localStorage 时保留 journal 并报 `localstorage-origin-not-open`；导出先授权后建目录、缺 ctx 拒绝、父目录 no-follow fd 写入；配额 stage 串行；MCP 文件读写稳定性校验；MCP 每次调用后采集；SSO origin 各自 marker。
- 产物：MCP 会话级 `--output-dir`；定时/启动补偿/终采；类型过滤；累计硬配额；`reconcile()`；导出改走 `fs.resolve` + `contains` + `fs/write-intent` + sandbox policy + `O_EXCL`。
- `browser_live_status` 不再分配槽位/恢复凭据/刷新空闲计时。

## 8. 坑与反直觉事实（踩过，别重复）

- **宿主 `rm -rf` 重建在用下载目录会让容器的 bind mount 静默失联**（容器仍写旧 inode，宿主看到空目录）。迁移/清理禁止重建在用目录。
- **MCP 把“导航到下载地址”报成 `isError: true` 的 `Download is starting`**，实际下载成功。不能当失败，也不能因此回滚。
- **raw Playwright 直连会截获下载**（文件不落 Chromium 下载目录），MCP 路径才会落到绑定目录。两条路径语义不同。
- **Playwright 1.63 没有移除 init script 的 API**，所以 localStorage 播种必须靠一次性 marker cookie 收口，否则用户登出后会被旧快照回灌。
- **宿主 `fs` 服务只有 `writeText`，没有二进制写**；产物导出是“服务解析目标 + `O_EXCL` 写进程路径”，不是沙箱内的原子写。
- **恢复必须先清 cookie**：只追加会留下上一个账号的其它 cookie（G-1 实测）。
- **宿主没有用户身份**（只有 harness-home 级匿名 UUID），所以 scope 只能是管理员白名单；任何“多租户隔离”表述都不成立。
- **provider 准入表可能为空**（历史故障）：v0.5.1 已改为“查不到就现场补获取一次”，失败原因会带出来。
- **recipe 的 click 只认 CSS selector**，`text` 只用于 wait/assert；用错会在参数校验前就被拒（v0.5.1）。
- **登录态捕获要剔除 `__dsh_restore_marker`**，否则会把内部标记发布进 revision。

## 9. 需要项目负责人决定的事

1. 是否启用共享、启用后用哪些 `bindings`（origin → accountKey）。
2. 是否给 MCP 设置会话级 `--output-dir`（会把 MCP 截图也纳入共享库）。
3. 配额数字与是否接受“只告警不删除”。
4. legacy `neko` 容器何时停用（目前只退出新池，仍在运行且占用 9222/8080/52100/52101）。
5. 是否按站点开启自动发布，以及哪些站点。

## 10. 快速上手清单

```bash
git log --oneline -5                     # 确认 HEAD 246c0bd
node --test "test/**/*.test.mjs"         # 185 通过
sed -n '1,80p' docs/p1-sharing-baseline.md
sed -n '1,60p' docs/p2-p3-sharing-closeout.md
grep -n "sharing" lib/index.js           # 配置与运行时装配
```
