# dsh-plugins

我的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件仓库。每个子目录是一个自包含的 Cordis bundle 插件：纯 JavaScript、零外部依赖（不 import 任何 `@deepseek-ai/*` 包），复制即用。

## 插件列表

| 插件 | 说明 |
| --- | --- |
| [dsh-delete-archived-session](dsh-delete-archived-session/) | 永久删除已归档会话：Web UI 菜单项 + 确认弹窗、agent 工具、斜杠命令 |

## 安装（任意插件通用）

1. clone 本仓库到本地任意位置：

   ```
   git clone https://github.com/not-happy/dsh-plugins.git
   ```

2. 在 DSH 会话里让 agent 安装（会弹一次审批确认）：

   > 用 plugin_manager 的 install_bundle 安装本地 bundle：`<仓库路径>\dsh-plugins\<插件目录名>`

3. 刷新 Web GUI 页面（F5）。宿主端安装即生效；`client.js` 只在页面装配时加载，必须刷新一次。

## 注意事项

- 插件按编写时的 DSH 版本契约实现（slot 名、gateway src-mode 发现等），建议与开发机使用相同或接近版本的 `@deepseek-ai/dsh`。
- bundle 安装进当前 profile 的配置，装哪个 profile 就在哪个 profile 生效。

## 仓库结构

```
dsh-plugins/
├── README.md
├── .gitignore
└── <插件名>/           # 每个插件一个自包含目录（合法 npm 包结构）
    ├── README.md       # 插件说明：功能、安装、限制
    ├── package.json    # bundle 清单 + dsh.client 声明
    ├── cordis.patch.yml
    ├── index.js        # 宿主端
    ├── client.js       # 浏览器端（如有 UI）
    ├── icon.svg
    └── locale/
```

## 引用

- **DSH 仓库**：<https://github.com/deepseek-ai/deepseek-harness>（CLI 位于 `apps/cli`）
- **npm 包**：[`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)
- **开发与测试版本**：`@deepseek-ai/dsh` 0.2.1-rc.5（Windows，web profile）
- **插件开发文档**：随包内置的 `cordis-plugin-development` skill（安装后位于 `<dsh 包目录>\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\`，含 host-plugin / ui-plugin / user-actions / verification 等 references 与 decoration 模板）；配套 skill：`cordis-composition-reference`（Loader YAML 方言）、`editing-cordis-compositions`
- **插件运行契约**：[Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) 服务/fiber 模型；Web UI 走 `window.__ModuleLoader__` 浏览器模块表（react、zod、`@deepseek-ai/dsh-client-ui-primitives` 等由宿主提供）
