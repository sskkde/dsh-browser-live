# P1 共享底座状态

- 日期：2026-11-10（Asia/Shanghai）。
- 对应方案：[跨会话登录态与文件共享执行方案](cross-session-sharing-plan.md) 第 8 节 P1。
- 状态：**底座模块与单元测试完成；共享默认关闭（`sharing.enabled=false`），未部署、未迁移任何真实数据。**

## 1. 已落地

| 模块 | 不变量 |
|---|---|
| [lib/service.js](../lib/service.js) 池改造 | 槽位 0 不再接 legacy `neko`；所有槽位独立容器/卷/viewer；端口区间 9300+/8300+/52200+ 与 legacy 的 9222/8080/52100/52101 不重叠；map v2 迁移把 v1 legacy 条目录入 `retired`（容器不删）；回收 `active → deleting → released`，容器真正消失前槽位不复用；删除失败保留条目与错误重试；lease 期间 TTL/LRU 都不动该槽位；池满且全忙返回 `BrowserLiveCapacityError` |
| [lib/sharing/scope.js](../lib/sharing/scope.js) | scope 只从活 agent 的 session id 解析；单组 `trusted-group`；子代理天然是成员；`allowCredentials=false` 时整组禁用凭据访问 |
| [lib/sharing/policy.js](../lib/sharing/policy.js) | native / 直连 MCP / `browser_gateway_call` 三条路径统一分类，网关取 `arguments.tool` 内层工具名；拒绝嵌套网关元工具；凭据类工具单列授权 |
| [lib/sharing/gate.js](../lib/sharing/gate.js) | 一个 `tools/execute` 监听器装在 provider 准入之前（`prepend`），先解析 scope、再分类、再授权；非浏览器工具直接放行 |
| [lib/sharing/auth-store.js](../lib/sharing/auth-store.js) | 按 `scopeId+siteKey+accountKey` 的不可变 revision；CAS（`expectedRevision`）+ 撤销 epoch 在同一临界区校验；`publish`/`revoke` 共用主键锁；目录 0700、文件 0600；temp→fsync→rename→fsync(dir)；`siteKey`/`accountKey` 编码为不透明路径组件并做 canonical 根包含校验；摘要与异常不含凭据 |
| [lib/sharing/artifact-store.js](../lib/sharing/artifact-store.js) | 不可变对象 `objects/<uuid>/data.bin`；metadata 原子提交后才可检索；崩溃留下的孤儿对象被 `stats()` 计数但不进 `list()`；`index.json` 可删可重建；`.crdownload` 拒绝入库；`sourceUrl` 只存 origin；文件名只作展示元数据；导出名 `safeExportName()` 消毒 |
| [lib/sharing/audit.js](../lib/sharing/audit.js) | 追加式 JSONL，文件 0600；凭据形字段替换为 `[redacted]`；URL 只留 origin；截断尾行被忽略而不是解析失败 |
| [lib/sharing/coordinator.js](../lib/sharing/coordinator.js) | 按 origin 绑定解析账号；恢复前先清目标域 cookie（含上一次恢复触及的域），再写 cookie、一次性 epoch 标记和 init script；同一容器代与原 revision 不重复恢复；revoked 直接拒；原生路径在操作前恢复、操作后撤标记；MCP 路径用 `needsPrepare` 免去每次 CDP 往返 |

## 2. 开关与默认值

`index.js` 新增 `sharing` 配置（默认关闭）：

```yaml
sharing:
  enabled: false          # 关闭时 gate 根本不安装，行为与共享前一致
  scopeId: trusted-group
  allowCredentials: true
  members: []             # 空 = 所有会话与子代理（当前运行决定）
```

启用后 gate 在任何浏览器工具执行前运行；非成员、凭据未授权、`gateway_call` 嵌套网关元工具都会被拒。**关闭时不拦截**，避免共享未启用却拒绝全部浏览器调用。

## 3. 尚未完成（P2/P3 前置）

1. **绑定写入与 save/load**：`browser_live_state save/load` 仍走旧 states 目录；要改成经 AuthStore 的显式发布（含 expectedRevision 与正向登录校验），并把绑定表接到配置。
2. **产物归集**：`browser_live_artifact` 工具（list/info/save），截图/下载采集器，`save` 改走宿主 `fs` 服务（当前 `browser_live_download save` 仍是裸 `copyFileSync`）。
3. **故障注入**：进程中断、磁盘满、删除失败重试的集成用例（当前只有存储层的崩溃一致性单测）。
4. **迁移演练**：v1 map → v2 的真实容器对账、legacy 容器退出新池的现场演练，以及回滚演练。

## 4. 测试

```bash
node --test "test/**/*.test.mjs"   # 111 项：gateway 14、recipe 10、admission 12、pool 10、policy 10、scope 7、gate 8、auth 9、artifact 15、audit 5、coordinator 11
node scripts/p0-auth-isolation.mjs # G-1 手动集成探针，需要本机 Chrome
```

## 5. 已知限制

- 身份仍是"同一 profile 内可信主体"，不是多租户隔离；方案 3.1 的 0700/0600 只防误读，不防同 UID 读取。
- `sharing.enabled=true` 后，所有会话与子代理共享同一 scope；这是当前运行决定，不是默认值。
- 产物完成信号仍靠目录 rename 约定；MCP 截图只扫 `--output-dir`。
