# dsh-delete-archived-session

永久删除 DSH 已归档会话的插件。DSH 原生只提供归档/取消归档，没有任何删除会话的 API；本插件补齐这一能力，一处实现、三个入口。

## 功能

删除一个已归档会话会彻底移除它的三处数据：

1. `$DSH_HOME/sessions/<projectKey>/<sessionId>/` 存储日志目录（扫描所有 project 目录，不依赖 cwd 映射，顺带清理项目已迁移的日志）；
2. `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` 投影缓存记录（best-effort，缓存本身 fail-soft）；
3. workspace 注册表条目（从所有 workspace detach + 从归档列表移除，侧边栏即时消失）。

失败顺序契约：先删磁盘文件，任何一步文件删除失败则**不动注册表**（会话保持归档状态，可重试）。

### 三个入口

| 入口 | 用法 |
| --- | --- |
| Web UI | 侧边栏**已归档**会话行的 "…" 菜单 → 红色"删除会话"（order 500，带分隔线）→ 宿主原生 RiskConfirmation 弹窗（需勾选"我了解此操作不可恢复"）。不依赖任何打开的会话。 |
| Agent 工具 | `delete_archived_session`，`action: "list"` 枚举归档会话（含 cwd/事件数/大小），`action: "delete"` + `sessionId` 删除 |
| 斜杠命令 | `/delete-archived-session <session-id>` 或 `/delete-archived-session list`（在某个会话内执行；有自删保护） |

## 实现要点（供二次开发参考）

- **宿主端** (`index.js`)：
  - 工具与命令注册走常规 `ctx.tools.register` / `ctx.commands.register`；
  - Web UI 的会话无关调用通过**手工伪造的 typert Remote 服务**实现：普通类 + 手写 `typertRemote` 冻结绑定 + 在 prototype 上 `Object.defineProperty` 写入版本化 Remote-method 描述符（`'@deepseek-ai/dsh-typert-protocol/remote-methods'`，`{version:1, methods:[...]}`），由 api-gateway 的 **src-mode** 动态发现（无需 zod、无需注册表条目、无需 import 任何 `@deepseek-ai/*` 包）。约束：方法必须在 prototype 上、参数为简单标识符（gateway 用 `Function.prototype.toString` 解析签名）、返回值 JSON-clean；
  - `ctx.provide('deleteArchivedSession', api)` 全树可见，fiber 生命周期随 bundle 启停。
- **浏览器端** (`client.js`)：
  - slot `sidebar.workspaces.session.menu.item` 注册菜单项（仅对 `archivedSessionIds` 中的会话显示，经 `ctx.workspaces.list` 的 uSES 快照订阅）；
  - 弹窗挂在 `shell.overlay` slot（菜单关闭会卸载菜单项组件，所以弹窗状态放模块级 store）；
  - 客户端用 `remote.$mount(contribution)` 挂载手工构造的 `deleteArchivedSession` 命名空间（参数 codec 伪 strict、结果 src-json），并从 `remote.namespaces.get(...)` 捕获方法闭包调用——**不要**在 React 组件里走 `remote.deleteArchivedSession.xxx` 属性访问（那是 sibling fiber 提供的点号键，会触发 "cannot get property without inject"）；
  - UI 全部使用宿主 primitives（`MenuItemButton`、`RiskConfirmation`、`IconTrashOutlineRegular`，从浏览器模块表 require）与 `--dsw-alias-*` 主题 token。
- **已加载的归档会话**：宿主没有公开的会话卸载 API，但 ArchivedSessionGate 保证归档会话不能执行模型步骤（idle）。删除前先 `sessions.flush()` 落盘缓冲，删除后 best-effort 广播 `api-session/removed`；结果带 `stillLoaded` 标记，内存副本滞留至宿主重启但不会写回。

## 安装

见[仓库根 README](../README.md)。简述：对 agent 说「用 plugin_manager 的 install_bundle 安装本地 bundle：`<绝对路径>\dsh-delete-archived-session`」，然后 F5 刷新页面。

- 改宿主端 `index.js` 后：plugin_manager `set_bundle` 先 disable 再 enable；
- 改浏览器端 `client.js` 后：只需刷新页面。

## 已知限制

- 依赖编写时 DSH 版本的内部契约（slot 名、gateway src-mode、typert 描述符格式、primitives 导出），DSH 大版本升级后可能需要适配；
- 删除不可恢复，没有回收站；
- 工具/命令路径只接受归档列表中的 id（`NOT_ARCHIVED` 拒绝），这是刻意的安全边界——不删活跃会话。
