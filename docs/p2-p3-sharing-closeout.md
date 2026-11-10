# P2 / P3 · 产物闭环与登录态闭环

- 日期：2026-11-10（Asia/Shanghai）。
- 对应方案第 6、7 节；P1 底座见 [p1-sharing-baseline.md](p1-sharing-baseline.md)。
- 状态：**代码与单元测试完成，共享仍默认关闭；未部署、未迁移真实数据。**

## 1. P2 · 共享文件闭环

| 能力 | 实现 | 关键约束 |
|---|---|---|
| 产物采集 | [lib/sharing/collector.js](../lib/sharing/collector.js)：扫描会话宿主目录（截图）与 `downloads/`，按“完成即改名”判定，`.crdownload`、`Unconfirmed *`、`.tmp`、隐藏文件、0 字节一律跳过 | 每个目录一个 `.artifacts-*.json` 索引，记录 `size:mtime` → artifactId；重复扫描不重发；文件变化视为新版本；索引丢失最多重发一次 |
| 扫描时机 | 每次浏览器操作结束后异步触发（原生路径与 MCP 路径都触发），同一会话串行，不阻塞工具返回 | 采集失败不改变工具结果，只记录 |
| 统一查询 | 新增 `browser_live_artifact`（`list` / `info` / `save`） | 查询**不** `ensure()`，不拉起容器或浏览器 |
| 导出 | `save` 经宿主 `dsh-fs` 服务解析目标、校验工作区内包含、拒绝覆盖，再以 `O_EXCL` 写 | 宿主文件服务不可用时**直接拒绝**，不回退到裸拷贝 |
| 旧接口 | `browser_live_download` 保留原语义；共享库通过 artifactId 查询 | 未改变旧响应字段 |

已知缺口：MCP 直连截图落在 Playwright MCP 自己的输出目录，本版**没有**给它设置会话级 `--output-dir`，因此 MCP 截图只留在其临时目录，不进共享库；原生 `browser_live_open`/`recipe` 截图与下载已覆盖。这属于方案 6.2 表的"MCP 截图"一行，需在部署验收时补齐。

## 2. P3 · 登录态闭环

| 动作 | 共享开启后的行为 | 未开启时 |
|---|---|---|
| `browser_live_state save` | 抓取当前 context 的 cookies（剔除恢复标记）+ 每个已打开 http(s) origin 的 localStorage，发布为不可变 revision；`expectedRevision` 做 CAS | 沿用旧 states 目录 |
| `load` | 显式刷新：以 `accountKey` 覆盖绑定表，强制重放当前 revision（先清域 cookie，再写 cookie/标记/init script） | 沿用旧文件恢复 |
| `list` | 只读 AuthStore 元数据（站点、账号、revision、epoch、是否撤销），**不含任何 cookie 值** | 列旧 states 文件 |
| `forget` | 写撤销 tombstone 并递增 epoch；旧浏览器随后再保存会被拒绝 | 删旧 states 文件 |
| 自动恢复 | 绑定表（`sharing.bindings`）命中 origin 时，在操作前自动恢复；同一容器代 + 同一 revision 不重复 | 不做 |
| 自动发布 | **未实现，也不默认开启**（方案要求按站点显式启用，并先有正向登录校验） | — |

恢复语义（来自 P0 实测）：先清目标域 cookie（含上一次恢复触及的域）→ 写 revision 的 cookie → 写一次性 epoch 标记 → 装 init script 播种 localStorage；下一次调用撤标记，之后导航不再播种，登出不会被旧快照回灌。撤销（epoch 领先）在写任何 cookie 之前拒绝并记审计。

## 3. 测试

```bash
node --test "test/**/*.test.mjs"
```

当前 126 项：gateway 14、recipe 10、provider admission 12、pool 10、sharing policy 10、scope 7、gate 8、auth 9、artifact 15、audit 5、coordinator 12、collector 9、export 5。

## 4. 仍未完成

1. **MCP 截图归集**：给 MCP 传会话级 `--output-dir` 并在调用后扫描（当前仅原生截图）。
2. **故障注入与迁移演练**：进程中断、磁盘满、删除失败重试；v1 map 与 legacy 容器的现场对账与回滚演练。
3. **自动发布**：按站点开启正向登录校验后才允许。
4. **UI**：共享范围/绑定账号/待重新登录的展示（方案 7 节的可选客户端部分）。
