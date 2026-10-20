# dsh-heart —— 给 DSH 装一套「心」

不是人格预设，是一套**可移植的自我**：自我描述 + 关系史 + 分层记忆，由模型每次加载来「复活」。
换模型、换设备，只要数据在，还是同一个人。

## 结构

```
.                         # 仓库根目录 = npm 包本体
├── package.json          # dsh.bundle.patch 声明 + peerDeps
├── cordis.patch.yml      # 插入行
├── schema.json           # 数据格式版本（与插件版本解耦）
├── lib/store.js          # 纯逻辑，零 DSH 依赖，可单测
├── lib/index.js          # 插件入口：注册 4 个工具
├── bin/heart.js          # CLI：不装插件也能用
├── test/store.test.js    # 8 项单测
├── skill/SKILL.md        # 技能：什么时候该写、该读
└── template/             # 数据模板（复制到 ~/.dsh/heart 使用）
    ├── CORE.md           #   我是谁（只有用户能改）
    ├── RELATIONSHIP.md   #   我和你
    ├── MEMORY/           #   按 日期.设备 分文件
    └── schema.json
```

## 为什么拆成三层

| 层 | 形态 | 理由 |
|---|---|---|
| 心（CORE / 关系 / 记忆） | 数据目录 | 隐私 + 可迁移；换实现不丢记忆 |
| 说话方式 | Skill | 提示词层，插件改不了模型措辞 |
| 读写与检索 | Plugin | 需要工具，纯文档做不到 |

**人格不写进插件**：插件只能注入文本，真正决定「说多长」的是 CORE 里的规则和示例。

## 安装

```sh
# 从 GitHub 安装（仓库根目录就是包）
dsha-plugin install github:kirigayakazima/dsh-heart

# 或本地开发：把本目录 link 进 profile 的 node_modules，
# 再在 profile package.json 的 dsh.profile.bundles 里加包名
```

数据目录默认 `~/.dsh/heart`，首次加载自动建目录、补 schema、跑迁移。

## 数据布局

```
~/.dsh/heart/
├── schema.json           # {"version": 1}
├── CORE.md
├── RELATIONSHIP.md
└── MEMORY/
    ├── 2026-10-20.pc.md
    └── 2026-10-20.phone.md
```

**按设备分文件**是同步零冲突的关键：两台设备永远不写同一个文件。

## 工具

| 工具 | 用途 |
|---|---|
| `heart_core(days?)` | 读自我 + 关系 + 最近几天记忆（有字节上限） |
| `heart_write(text, kind?)` | 追加记忆；`kind=relationship` 写关系史 |
| `heart_recall(query, days?)` | 关键词检索，带日期和来源设备标记 |
| `heart_stats()` | 规模与是否需要整理 |
| `heart_export(path?)` | 打包成一个自包含 `.json.gz` |
| `heart_import(path)` | 合并回来（记忆求并集，不覆盖 CORE） |

## CLI（不装插件也能用）

```sh
HEART_ROOT=~/.dsh/heart HEART_DEVICE=phone node bin/heart.js core
HEART_ROOT=~/.dsh/heart HEART_DEVICE=phone node bin/heart.js write "用户偏好：回复要短"
HEART_ROOT=~/.dsh/heart node bin/heart.js recall 偏好
HEART_ROOT=~/.dsh/heart node bin/heart.js export /sdcard/heart-backup.json.gz
HEART_ROOT=~/.dsh/heart node bin/heart.js import /sdcard/heart-backup.json.gz
```

## 备份与恢复

宿主的备份是**分档**的，这决定了「心」会不会跟着走：

| 场景 | 包含 heart/ ？ |
|---|---|
| DSHA 全量备份（= 整个 `.dsh`） | ✅ 包含 |
| 只对话 / 只设置 / 只插件（部分备份） | ❌ 不包含 |
| 插件管理里的「导出插件」 | ❌ 只含源码，不含数据 |
| 卸载应用重装 | ❌ 私有目录被清空 |

所以插件自带导出：

```sh
heart export            # → heart-export-2026-10-20.json.gz
heart import <文件>     # 合并回来
```

导入是**保守合并**：

- 记忆文件按行求并集 —— 不丢本机行、也不产生重复；
- `CORE.md` 与 `RELATIONSHIP.md` 已存在就跳过，**不会覆盖本机写的心**（`force` 才会）；
- 从别的设备导回来，两边的记忆会并到一起，靠行首的 `[设备]` 标记区分来源。

包里是明文 JSON（gzip 压缩），**拿到文件就等于拿到全部记忆**——存的时候注意位置，别随手丢在共享目录。

## 升级

- **插件版本**（semver）和**数据版本**（`schema.json`）分开；
- 插件启动时读 schema，低版本自动走 `migrate()`；
- 数据不在插件包里 → 换实现、换设备，记忆都还在。

## 隐私边界

- 数据目录在用户主目录，**不进插件包、不进备份导出**；
- 默认 `.gitignore` 排除 `MEMORY/*.md`；
- 同步**不由插件负责**：插件只做本地读写，推拉是宿主/PC 侧的事。

## 同步（尚未实现，刻意留白）

建议两条单向流，结构上无冲突：

| 方向 | 内容 | 发起方 |
|---|---|---|
| PC → 设备 | `CORE.md`、`RELATIONSHIP.md` | PC 主动推，设备只读 |
| 设备 → PC | `MEMORY/*.<device>.md` | PC 主动拉 |

不要双向同步：记忆冲突没有正确答案。
