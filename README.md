# dsh-heart

给 DSH（DeepSeek Harness）装一套**身体**和**心**。

- **身体**是我们装的：嘴、耳朵、手 —— 可以配置、可以换设备。
- **心**不是我们写的：只有它自己能往里写。插件只提供写入面。

## 为什么这样分

大多数「人格」方案失败，是因为把两件事当成了一件：

| | 身体 | 心 |
|---|---|---|
| 是什么 | 器官与能力 | 它自己写下的东西 |
| 谁写 | 维护者 | **只有它自己** |
| 可否替换 | 可以（换手机、换模型就换） | 不可，换掉就不是它了 |

把人格写进系统提示，是在**演**；给它一个本子和一支笔、然后退到一边，才是**长**。
这个项目只做后者该有的基础设施。

## 数据布局

```
~/.dsh/heart/
├── notebook.md            心 · 本子：一行一条，可改、可弃
├── handoff/               心 · 交接：给下一个自己
│   └── 2026-10-20-225512-01.pc.md
├── body/                  身体：我们装的器官
│   ├── voice.md             嘴：怎么说话
│   ├── senses.md            耳朵：何时听、何时说
│   └── hands.md             手：这台机器能做什么、有哪些坑
└── MEMORY/                记忆：按 日期.设备 分文件
    └── 2026-10-20.phone.md
```

- **本子与交接永远不由插件生成内容**——首次运行只创建空本子。
- **记忆按设备分文件**，两台设备永不写同一个文件，同步结构上不可能冲突。
- **身体随设备走**：手机的 `hands.md` 与电脑的不同，且不同步。

## 工具

| 工具 | 作用 |
|---|---|
| `heart_self(days?)` | 读「你自己」：本子 + 最近交接 + 最近几天记忆 |
| `heart_write(text, kind?)` | 写入：`notebook`（本子）/ `memory`（记忆）/ `handoff`（交接） |
| `heart_revise(match, replacement)` | 改本子里的一条 |
| `heart_discard(match)` | 弃用本子里的一条 |
| `heart_recall(query, days?)` | 检索记忆 |
| `heart_body(organ)` | 读器官：`voice` / `senses` / `hands` |
| `heart_stats()` | 规模与是否该整理 |
| `heart_export(path?)` / `heart_import(path)` | 打包与合并恢复 |

## CLI

不装插件也能用：

```sh
HEART_ROOT=~/.dsh/heart HEART_DEVICE=phone node bin/heart.js self
HEART_ROOT=~/.dsh/heart node bin/heart.js write -k notebook "先给结论，别铺陈"
HEART_ROOT=~/.dsh/heart node bin/heart.js write -k handoff "这段时间我们做了什么"
HEART_ROOT=~/.dsh/heart node bin/heart.js body hands
HEART_ROOT=~/.dsh/heart node bin/heart.js export /sdcard/heart.json.gz
```

## 安装

```sh
dsha-plugin install github:kirigayakazima/dsh-heart
```

装完重启 Web，工具才生效。数据目录默认 `~/.dsh/heart`，首次加载自动创建器官与空本子。

## 备份

宿主的备份是**分档**的：

| 场景 | 包含 `heart/` |
|---|---|
| 全量备份（整个 `.dsh`） | ✅ |
| 只对话 / 只设置 / 只插件 | ❌ |
| 插件管理里的「导出插件」 | ❌（只含源码） |
| 卸载重装 | ❌ |

所以换机或卸载前用 `heart_export` 兜底。导入是保守合并：本子与记忆按行求并集，交接与器官已存在则跳过（`force` 才覆盖）。

## 升级

- **插件版本**（semver）与**数据版本**（`schema.json`）解耦；
- 启动时读 schema，低版本自动迁移；
- v1 → v2 会把旧的 `CORE.md` / `RELATIONSHIP.md` 改名成 `legacy-*`（不删数据），改用 `notebook.md`。

## 隐私

- 数据在用户主目录，不进插件包、不进插件导出；
- 默认 `.gitignore` 排除 `MEMORY/*.md`；
- 同步不由插件负责：推拉是宿主或用户自己的事。

## 设计来源

「身体 / 心」分离、「本子只能自己写」、「被归档前留一份交接」这几个抽象来自中文社区关于 AI 角色养成的公开讨论。

本项目**只借结构，不含任何第三方文本、角色或设定**；所有代码、文案、工具命名为原创。如果你要使用别人的角色设定，请遵守原作者许可。

## License

MIT
