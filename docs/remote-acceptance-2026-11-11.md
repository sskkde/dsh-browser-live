# 远端隔离验收记录（dsh-browser-live 0.9.0，2026-11-11）

## 结论

在远端测试服务器 `<remote-test-host>` 创建了一次性隔离环境，使用真实 Docker 29.9.2、真实 Neko/Chromium 容器和虚构站点，跑通：

1. A 会话打开登录页并保存绑定登录态；
2. 截图产物发布；
3. A 释放槽位后，`browser_live_status` 不分配、不恢复；
4. 空白 B 会话**首请求即恢复 Cookie 和 localStorage**（站点在首段页面脚本中回传观察到 `sid=WORK`、`pref=dark`）；
5. B 的真实下载完成并发布；
6. `forget` 撤销后活动 B 实例被清理，下一次请求不再回灌；
7. B 释放后截图/下载产物仍可查询。

**同时发现并修复一个真实缺陷**：Playwright `connectOverCDP` 默认会覆盖浏览器下载目录到 Playwright artifacts 目录，导致 Neko 容器绑定到宿主机的 `/home/neko/Downloads` 收不到文件。已在 `lib/tools.js` / `lib/provider.js` 的 CDP attach 上显式 `{ noDefaults: true }`，保留 Chromium 自己的下载行为；远端复测通过，本地回归断言已补。

本记录**不等于完整上线验收**：未启动完整 DSH Web/真实模型回合，未验证 MCP `browser_take_screenshot`/PDF、nginx 查看器、导出写入、配额磁盘满、TTL、迁移/回滚。上述仍未测。

## 隔离资源

| 资源 | 值 |
|---|---|
| 运行根 | `<test-root>`（已删除） |
| DSH runtime | 0.2.1-rc.2，安装于运行根 `runtime/` |
| DSH_HOME | 运行根 `home/.dsh`（一次性） |
| 插件 | `dsh-browser-live-0.9.0.tgz`，本地 `npm pack`，安装进隔离 profile |
| 虚构站点 | `127.0.0.1:38931`（仅回环） |
| 浏览器容器 | `neko-6zsgmhev`（A）、`neko-f28mc66u`（B），host network，单容器串行 |
| 卷 | `neko-profile-6zsgmhev`、`neko-profile-f28mc66u`（已删除） |
| 端口 | CDP 9300、Web 8300、UDP/TCP mux 52200/52201（均未占用） |
| DSH Web | 未启动（端口 13082 预留给可选启动，实际未用） |
| 镜像 | `neko-chromium-cdp:latest` 与基础 `m1k1o/neko:chromium`（已删除） |

容器启动时额外注入 `--memory 768m --memory-swap 1g --cpus 1 --shm-size 512m`，避免资源受限的共享主机与 `<existing-container>` 争抢内存。

## 执行结果

- 远端 `npm install @deepseek-ai/dsh@0.2.1-rc.2`：617 包，退出码 0。
- 隔离 profile 安装插件：`dsh-browser-live` 0.9.0，`npm install` 退出码 0。
- `dsh --profile web --patch patch.yml --dump-config`：退出码 0，配置树含 `browser-live` 与 enabled sharing；本地证据：`.evidence/remote-acceptance/run-20261111-a/dump-config.txt`（未随公开仓库提交）。
- 验收脚本：9 个步骤全部 PASS，退出码 0；本地证据：`.evidence/remote-acceptance/run-20261111-a/acceptance.json` 与 `acceptance.log`（未随公开仓库提交）。
- 首轮失败记录保留在本地 `.evidence/remote-acceptance/run-20261111-a/acceptance-first-run.json`（下载步骤超时，用于证明缺陷存在），修复后复测全绿。
- 站点首段脚本观测证据（本地 `seen.ndjson`，未随公开仓库提交）：
  - 恢复时：`{"c":"sid=WORK","l":"dark","t":"dark","p":"/app"}`
  - 撤销后：`{"c":"","l":"","t":"","p":"/app"}`

## 下载缺陷细节

- 现象：`browser_live_recipe` 点击下载链接成功，`browser_live_download list` 为空；容器内 `/home/neko/Downloads` 为空。
- 根因：`playwright-core` 的 `connectOverCDP` 在默认参数下会为 persistent context 设置 `acceptDownloads: accept`，并把 `Browser.setDownloadBehavior` 的 `downloadPath` 指向 Playwright 的 artifacts 目录；绑定在容器内的下载目录因此收不到文件。
- 修复：所有 host 端 CDP attach（工具、状态、撤销清理、provider 清理）传 `{ noDefaults: true }`，让 Chromium 保留自身下载目录；见 `lib/tools.js:188,446,874`、`lib/provider.js:476`。
- 回归：`test/sharing-assembly.test.mjs` 断言所有 attach 都带 `noDefaults: true`；远端复测下载文件落盘到宿主 `.../downloads/sample.txt` 并由 collector 发布。

## 清理

验收后按精确资源清理：

- 停止虚构站点进程，确认 38931 无监听；
- 删除 `neko-6zsgmhev` / `neko-f28mc66u` 容器与两个精确 profile 卷；
- 删除 `neko-chromium-cdp:latest`、`m1k1o/neko:chromium` 两个本次拉取/构建的镜像；
- 删除整个 `<test-root>`；
- 复核 `docker ps` 仅剩既有 `<existing-container>`，`<test-root-parent>` 其他目录未动，13082/38931/8300/9300/52200/52201 无监听；
- 磁盘可用空间下降主要来自 Docker build cache；未执行全局 prune。

## 仍未测（不得算通过）

- 完整 DSH Web/agent 回合与三路径门禁（无生产凭据，未启动 Web）；
- MCP `browser_take_screenshot`/PDF 与 gateway_call 真实路径；
- nginx 查看器（远端无指向 13082 的 vhost，且 admin 未做 nginx 修改）；
- 导出写入远端真实 `dsh-fs-local`（本地已测，远端未测）；
- 配额磁盘满、崩溃/重启、TTL、迁移/回滚演练；
- 两账号 Cookie 域冲突、SSO 同 host 多端口限制、晚完成下载事件。

## 当前状态

- 已写代码：是（工作树 0.9.0；本次新增 `noDefaults` 修复，未提交）。
- 已测试：本地 185/185；远端隔离真实浏览器 9 步通过。
- 已部署：否（生产 profile 仍 0.5.0；远端环境已释放）。
- 已启用：否（`sharing.enabled` 生产仍 false）。
