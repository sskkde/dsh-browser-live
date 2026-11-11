# P2 / P3 · 产物闭环与登录态闭环

- 日期：2026-11-10（Asia/Shanghai）；第二轮收口更新。
- 对应方案第 6、7 节；P1 底座见 [p1-sharing-baseline.md](p1-sharing-baseline.md)。
- 状态：**代码与确定性测试完成（185/185）；远端隔离真实浏览器单场景 9 步通过；完整 Web/MCP/迁移演练仍未完成；共享仍默认关闭；未部署、未迁移真实数据。**
- 本轮缺陷清单与修复追踪见 [sharing-followup-plan.md](sharing-followup-plan.md)，命令与证据见 [verification-2026-11-10-sharing-followup.md](verification-2026-11-10-sharing-followup.md)。

## 1. P2 · 共享文件闭环

| 能力 | 实现 | 关键约束 |
|---|---|---|
| 产物采集 | [lib/sharing/collector.js](../lib/sharing/collector.js)：扫描会话截图目录、`downloads/` 与 MCP `mcp/` 输出根；`.crdownload`、`Unconfirmed *`、`.tmp`、`.part`、隐藏文件、0 字节跳过；stage 后再次 stat，读写期间变化的文件不发布 | 每个目录一个 `.artifacts-*.json` 索引；只有 metadata 已提交的对象可检索 |
| 类型边界 | 图片 → `screenshot`，PDF → `pdf`，下载目录任意完成文件 → `download`；MCP 目录的 `.yml`/`.log`/tracing/video 只报告不支持 | 不把 tracing/video 当截图等价物 |
| 扫描时机 | 原生工具与 **MCP/provider 每次调用后**都触发；**独立定时器**（`sharing.artifactScanIntervalMs`，默认 60s）；启动补偿扫描（按 `.sharing-session.json` marker）；容器回收前终采 | 不依赖下一次原生工具调用；同一会话串行（后来者等待在途扫描） |
| 失败可见 | 采集失败写入 `lastCollect` 诊断、`warn` 日志；截图发布在原生响应里返回 `artifact: {published, artifactId?, reason?}` | 不静默吞掉归集失败 |
| MCP 截图/PDF | provider 给直连与 gateway 内层都传 `--output-dir <session>/mcp`；采集器扫描该目录 | P0 C10 的目录语义 |
| 统一查询 | `browser_live_artifact`（`list` / `info` / `save`） | 查询不 `ensure()`、不拉起浏览器 |
| 导出 | [lib/sharing/export.js](../lib/sharing/export.js)：缺 ctx 直接拒绝；**先** lexical sandbox 判定、再 mkdir、再 `fs.resolve`/`contains`/`fs/write-intent`/canonical sandbox；用 no-follow 父目录 fd + `/proc/self/fd` 做最终 `O_EXCL|O_NOFOLLOW` 写 | 真实 `dsh-fs-local` 集成测试覆盖越界/符号链接/父目录符号链接/只读/越根/覆盖/拒绝先于建目录 |
| 旧接口 | `browser_live_download` 保留原字段；`save` 改走同一授权写入器；`list` 附带已发布文件的 `artifactId` | 不改变原响应字段 |
| 配额 | `sharing.quotaBytes`（默认 `null` = 不改变保留策略）；达到配额停止新发布、保留源、不删历史 | stage 与 publish 两个窗口都判定；有硬配额时 stage 串行，避免并发快照超配额；`reconcile()` 只报告孤儿/缺失 |

已知缺口与限制：
- 容器内真实下载完成事件、磁盘满/进程中断的现场演练未做（单测覆盖了存储窗口与配额）；tracing/video 不自动发布。
- 宿主 `@deepseek-ai/dsh-fs` 0.2.1-rc.2 只有 `writeText`，没有二进制写入 API。导出因此使用同一授权缝的等价校验（`resolve` + `contains` + `fs/write-intent` + `SandboxExecutionPolicy`）后以 `O_EXCL|O_NOFOLLOW` 写字节；真实 `dsh-fs-local` 集成测试覆盖，但不是后端原生的二进制写接口。
- 撤销时如果没有任何页面停留在被恢复的 origin，Cookie 会清除，但该 origin 的 localStorage 无法在不导航的前提下删除；此时返回 `localstorage-origin-not-open` 并保留 restore journal，等待后续重试，不报假成功。

## 2. P3 · 登录态闭环

| 动作 | 共享开启后的行为 | 未开启时 |
|---|---|---|
| `browser_live_state save` | 以当前可见标签的精确 origin 建 `siteKey`；该 origin 必须已在 `sharing.bindings` 中绑定；显式 `name` 只能等于绑定账号；只收绑定主机 + `cookieDomains` 的 Cookie、`{origin} ∪ ssoOrigins` 的 localStorage；返回 `revision/epoch`；`expectedRevision` 做 CAS | 沿用旧 states 目录 |
| `load` | 显式刷新：`force` 重放当前 revision；空白实例可按账号反查绑定 origin；marker 留给下一次导航 | 沿用旧文件恢复 |
| `list` | 只读 AuthStore 元数据（site/account/revision/epoch/revoked），不含 Cookie 值 | 列旧 states 文件 |
| `forget` | 写 tombstone + 递增 epoch；再对 restore journal 中同账号的活动实例逐个 attach，清 Cookie/已播种 localStorage/marker；返回每实例结果；已撤销账号不重复递增 | 删旧 states 文件 |
| 自动恢复 | 绑定表命中 origin 时，在**首个受保护请求前**恢复：原生工具用本次 `url`，MCP 用 `browser_navigate` 参数（含 `gateway_call` 内层参数） | 不做 |
| 恢复日志 | `<scopeRoot>/coordinator.json`（0600）持久化 revision/域/origin/键名，无 Cookie 值；重启后撤销仍能清理活动实例 | — |
| 自动发布 | **未实现，也不默认开启** | — |

恢复语义：目标 origin 由本次操作给出（不靠“已打开页面”猜）；清目标域 Cookie → 写 revision Cookie → 写一次性 `epoch:revision` marker → 追加按 `epoch:revision` 区分的 init script；脚本播种后自行让 marker 过期，后续导航/登出不会回灌。撤销在写任何 Cookie 前拒绝并记审计。

## 3. 工具与查询的副作用边界

- `browser_live_status`：只读 map 与容器探针；无条目不分配；不恢复凭据；不更新 `lastUsed`；容器未运行时不上报标签页。
- `browser_live_state list`、`browser_live_artifact list/info`：不 `ensure()`、不 attach、不访问网站。
- 文件查询不依赖来源容器存活；已发布对象从共享库读取。

## 4. 测试

```bash
node --test "test/**/*.test.mjs"   # 185 项（本轮新增 59）
```

新增：`sharing-assembly` 10、`pool-safety` 13、`sharing-export-integration` 8（真实 fs）、`artifact-quota` 6；另扩充 coordinator 16、collector 4、export 2。

## 5. 仍未完成

1. **隔离浏览器/容器验收**：已在 `<remote-test-host>` 完成 A/B 串行、首请求恢复、撤销、截图/下载 9 步；A01 并行、A08 MCP/gateway、A10 晚完成、A12 磁盘满、A13 回收失败仍待授权。
2. **迁移/回滚演练**：v1 map → v2 的真实容器对账、legacy 容器退出新池的现场演练（代码已备份 map 并保留 retired 条目）。
3. **自动发布**：按站点正向登录校验，未实现（默认关闭）。
4. **UI**：共享范围/绑定账号/待重新登录展示（方案 7 节可选部分）。
5. **生产部署**：0.9.0 未打包、未安装、未重启；当前 profile 仍是 0.5.0。
6. **已知限制**：journal 写失败时只保留进程内记录，重启后的清理/撤销可能找不到该实例；同一 hostname、不同 scheme/port 的多个 SSO origin 共用 host 级 marker，不能保证各自首导航都完成 localStorage 播种（请为 SSO 使用不同主机名）。
