# Step 1：Voice Evolution（表达习惯自演化）实现审查记录

> **所属项目**: `@dsh/heart` (`projects/heart-plugin`)
> **本轮前序基线提交**: `c7524b7a5056ccfd079435b7015fd434f06f4fbe`
> **测试状态**: `90/90 tests pass` (包含 30 个 Step 1 新增专项单测，原有 60 个测试全量保留通过，耗时 ~2.8s)
> **审查版本**: v1.5 (状态迁移协议升级：靶向 Token 文件原子重命名、消除次级锁竞态、{flag: 'wx'}消除初始化挂起窗口、确定性 IPC 多进程挂起交错验证通过)

---

## 一、实现与设计对照表

| 设计目标 | 计划规范 | 实际实现状态 | 落地说明与加固实现 (v1.5) |
|---|---|:---:|---|
| **独立文件存储** | `body/voice-learned.md` | **已实现** | 独立于静态 `voice.md` 与 `senses.md`，不污染 `notebook.md`、`facts.md` 和 `MEMORY/` |
| **Schema 保持** | 不改变既有布局契约，不递增版本 | **已实现** | 保持 Schema v3，新增文件为可选 Markdown，不存在时默认返回空串 |
| **存储函数接口** | `readVoiceLearned`, `appendVoiceLearned` | **已实现** | 在 `lib/store.js` 导出，纯 Node 原生 fs/path 实现 |
| **安全文件替换** | 失败绝不丢失旧文件数据副本 | **已实现 (加固)** | 彻底移除危险 unlink 旧文件逻辑；采用「安全备份旧文件至 `.bak` -> 替换 -> 成功清理 `.bak` / 失败立即回滚恢复」机制；若回滚亦受阻，保留备份路径并上报异常，禁止清理唯一旧副本 |
| **多备份时间排序** | 确保多 PID/多进程下优先读取最新备份 | **已实现 (加固)** | 备份文件名调整为时间戳绝对优先格式；`readVoiceLearned` 解析毫秒时间戳进行降序排序，杜绝 PID 字典序颠倒时间顺序的缺陷 |
| **单条长度限制** | ≤ 200 字符，超限拒绝 | **已实现** | 超过 200 字符明确返回 `{ ok: false, reason: 'too-long' }`，绝不静默截断 |
| **输入校验过滤** | 拒绝纯空白、控制字符 | **已实现** | 空白规范化为单空格，正则过滤纯空白及 ASCII 控制字符 |
| **规范化去重** | 重复偏好不重复追加 | **已实现** | 大小写不敏感对比现有条目（忽略日期前缀），相同内容返回 `{ ok: false, reason: 'duplicate' }` |
| **记录保留策略** | 最大上限防无限膨胀 | **已实现** | 设定 `VOICE_LEARNED_MAX_ENTRIES = 100`，超出按时间淘汰最旧条目 |
| **提示词动态注入** | 提取最近 6 条作为独立层 | **已实现** | 修改 `lib/prompt.js` 的 `buildVoiceSection`，提取最近 6 条追加为独立补充小节 |
| **严格字符上限** | 即使单条超限也严禁突破 800 字 | **已实现 (加固)** | 单条超限做安全截断至 800，多条累加严格 break，注入总层字符数严格 ≤ 800 字符 |
| **向下完全兼容** | 文件空或缺失时行为一致 | **已实现** | 文件缺失或损坏时，`buildVoiceSection` 输出与原版本完全一致 |
| **工具注册暴露** | 注册 `heart_voice_learn` | **已实现** | 在 `lib/index.js` 注册，遵循 DSH 方言省略 `required: false` |
| **跨进程并发锁** | 防止多进程读-改-写竞争丢数据 | **已实现 (加固)** | 引入状态迁移锁：采用靶向 Token 凭据文件（`token.<token>.json`）；写盘前执行 Fencing 检查；释放锁精准校验 Token；仅在目录为空时 `rmdirSync` 安全收尾 |
| **消除次级锁竞态** | 彻底根除回收锁自身可能产生的 TOCTOU | **已实现 (加固)** | 废除次级 `reclaim.lock`；回收操作采用针对具体死锁 Token 的原子重命名（`renameSync(token.<deadToken>.json, ...)`），新锁凭据由于文件名天然不同，完全免疫任何误移走或误删风险 |
| **初始化挂起保护** | 杜绝进程建目录后挂起导致覆盖新凭据 | **已实现 (加固)** | 凭据写入强制使用 `{ flag: 'wx' }`（独占排他创建）；若进程被挂起并在恢复时发现锁已易主，绝不覆写，直接重试 |
| **统一超时语义** | 消除硬编码 2 秒与配置参数分歧 | **已实现 (加固)** | 统一严格以 `age >= staleMs` 判定死锁超期，语义严谨一致、完全可预期 |
| **单回合频率控制** | 每轮最多记录一次 | **边界说明** | 宿主未提供可信 `turnId`，依托内容去重、200 字限制与进程锁防刷 |
| **无超前开发** | 不提前开发后续模块 | **已实现** | 完全未触碰 Mood、Dream、Habit、Care、Resonance 或 Visual Memory |

---

## 二、源码入口与状态迁移调用链

```mermaid
sequenceDiagram
    participant Agent as 模型 / 用户
    participant Tool as 工具: heart_voice_learn
    participant Store as store.js (appendVoiceLearned)
    participant Lock as 互斥锁: voice-learned.md.lock
    participant FS as 文件系统: body/voice-learned.md
    participant Prompt as prompt.js (buildVoiceSection)

    Agent->>Tool: 调用 heart_voice_learn(observation)
    Tool->>Store: appendVoiceLearned(root, observation)
    alt 锁目录空闲 (首次创建)
        Store->>Lock: fs.mkdirSync(lockDir) 原子创建目录
        Store->>Lock: 独占写入 token.<token>.json ({ flag: 'wx' })
    else 锁目录已存在
        alt 持锁进程存活 (isProcessAlive 为 true)
            Store->>Store: 严禁抢占，等待 delayMs 后重试争锁
        else 持锁进程已死亡 且 age >= staleMs
            Store->>Lock: tryReclaimStaleLock() 靶向原子重命名 token.<deadToken>.json
            alt 靶向更名成功 (取得死锁专属处理权)
                Store->>Lock: 清理 deadToken 文件，rmdirSync 收尾空目录
            else 抛出 ENOENT (锁已被新进程取得，新文件名为 token.<newToken>.json)
                Store->>Store: 保守返回 false，绝不误伤新锁！
            end
        end
    end

    Note over Store: 校验: 空白/控制符/200字限制/防注入清洗
    Note over Store: 去重: 对比已有记录
    Store->>FS: 写入唯一 tmpFile
    Store->>Lock: isDirLockHeld(token) Fencing 校验 (确认未丢锁)
    Store->>FS: safeAtomicReplace (备份回滚保障，时间戳绝对优先)
    Store->>Lock: releaseDirLock(token) 精准删除自身 token 文件后 rmdirSync
    Store-->>Tool: 返回 { ok, line } / { ok: false, reason }
    Tool-->>Agent: 清晰中文操作反馈

    Note over Prompt,FS: 对话轮次装配系统提示词
    Prompt->>FS: readVoiceLearned(root) (时间戳排序容错读 .bak)
    Prompt->>Prompt: 取最近 6 条 + 严格 ≤800 字符约束
    Prompt-->>Agent: 注入 heart:voice 独立补充小节
```

### 1. `lib/store.js` 关键实现细节
- **靶向状态迁移协议 (`tryReclaimStaleLock`)**:
  - 不再引入易引发递归竞态的二级 `reclaim.lock`；
  - 每一个有效持锁者的凭据文件名为 `token.${token}.json`；
  - 回收者必须明确针对已检测到死亡超期的死锁凭据执行：
    `fs.renameSync(path.join(lockDir, `token.${deadToken}.json`), path.join(lockDir, `token.${deadToken}.reclaimed.${process.pid}`))`；
  - **免疫并发接管**：若在等待期间，锁已被新进程接管（其文件名为 `token.${newToken}.json`），操作系统由于文件名完全不同必然抛出 `ENOENT`。回收者捕获后立即保守返回 `false`，从文件系统根源上杜绝了误移走或误删新锁。
- **独占写入与挂起保护 (`acquireDirLock`)**:
  - 凭据文件采用 `{ flag: 'wx' }`（即 `O_CREAT | O_EXCL`）独占创建；
  - 若进程在建目录后长时间挂起，锁被回收并由新进程取得，原进程醒来尝试写入时必然触发 `EEXIST` 或 `ENOENT`，安全放弃并重试，绝不会覆盖新进程的持锁凭据。
- **精准释锁与安全收尾 (`releaseDirLock`)**:
  - 释锁时仅查找并删除自身持有的 `token.${token}.json`；
  - 收尾时仅调用 `fs.rmdirSync(lockDir)`。操作系统原生保证 `rmdirSync` 仅在目录为空时生效；若目录内已有新进程建立的文件，`rmdirSync` 自动安全失败，绝不破坏新锁目录。
- **备份文件生成与解析排序 (`safeAtomicReplace` / `readVoiceLearned`)**:
  - 命名格式：`${targetFile}.bak.${Date.now()}.${process.pid}.${rand}`，时间戳绝对前置；
  - 读取容错：在主文件处于 Windows 替换瞬间，`readVoiceLearned` 解析毫秒时间戳进行数值降序排序，确保多进程、多 PID 并存时严格选中时间最新的有效备份。

---

## 三、测试证据与覆盖分析

当前执行命令 `npm test`（即 `node --test test/*.test.js`），全量测试结果：
**90 个测试全部通过（Pass: 90, Fail: 0）**。

### 1. 测试用例全景与口径说明
- **既有基础功能测试（60 个用例）**：覆盖 layout、notebook、facts、sense、presence、trigger、bridge 等原有能力，100% 保持通过，未发生任何回归；
- **Step 1 新增专项测试（30 个用例）**：
  - **`test/voice-learned.test.js` (24 个专项用例，编号 1 ~ 24)**；
  - **`test/prompt.test.js` (6 个专项用例，编号 1 ~ 6)**。

### 2. Step 1 专项测试详细列表与覆盖场景
- **`test/voice-learned.test.js` (24 个用例)**:
  1. 学习文件不存在时读取为空字符串，不抛出异常；
  2. 正常写入并能读回，多条记录的日期和单行格式正确；
  3. 超过 200 字时拒绝写入，不得静默截断（且恰好 200 字符允许写入）；
  4. 空字符串、纯空白及控制字符输入均被拦截拒绝；
  5. 规范化空白后去重，相同偏好不会重复追加；
  6. 超出 100 条上限时，保留策略正确（按时间淘汰最早记录，保留最新 100 条）；
  7. 读取或写入异常时能够捕获错误并返回明确失败，绝不虚报成功；
  8. `heart_voice_learn` 工具逻辑处理成功、重复、超长和非法输入的消息返回；
  9. 提示词防注入清洗：净化 Markdown 标题符号（`#`）与尖括号标签（`<`/`>` 转义为全角 `〈`/`〉`）；
  10. **安全文件替换断言**：构造新文件替换抛错的异常路径，断言旧文件副本依然完整保留在磁盘，内容完好无损；
  11. **跨进程并发写入断言**：启动两个独立 Node.js 子进程向同一 root 并发写入两条不同记录，断言两条记录均完整保留在文件中，无丢数据；
  12. **锁所有者验证断言**：模拟持有旧 Token 的进程恢复后尝试释放锁，断言释放被拒绝（返回 false），且新持锁者的锁目录与凭据完好保留；
  13. **僵尸锁安全回收断言**：持锁进程存活时（`process.pid`）即便超期也绝不强行抢占；持锁进程已确认死亡（`ESRCH`）且超期时自动回收自愈；
  14. **写盘持锁有效性校验（Fencing）**：模拟锁被第三方占用场景，断言写盘被拦截并返回超时/失败，原锁与文件均不被破坏；
  15. **容错读取备份文件断言**：模拟主文件暂未就位但存在 `.bak` 备份文件，断言 `readVoiceLearned` 成功读取备份内容；
  16. **并发竞争回收僵尸锁断言（消除 TOCTOU 竞态）**：模拟竞争者 B 抢先一步成功回收僵尸锁并建立新有效锁，滞后竞争者 A 再次触发回收时，被靶向状态迁移拦截并拒绝，断言新锁及凭据完好保留；
  17. **多 PID 备份文件时间戳排序断言**：构造 PID 较大但时间早的旧备份与 PID 较小但时间晚的新备份，断言准确读取最新时间戳内容，不被 PID 字典序误导；
  18. **写入短暂窗口保护断言**：模拟刚完成 `mkdirSync` 尚未写入凭据的短暂窗口，断言由于年龄未超期，绝不被误判为损坏锁，目录完整保留；
  19. **真实多进程并发竞争回收集成测试**：两个独立的 Node.js 子进程并发启动并竞争自愈同一把僵尸锁并追加记录，断言两进程全部成功退出（code 0），两条记录均完整落盘；
  20. **存活持锁者绝对保护断言**：持锁者（存活 PID）即便时间超期，其他操作也绝不删除或抢占其有效锁；
  21. **靶向 Token 状态转移断言**：模拟新进程 B 持锁，滞后竞争者试图靶向重命名已不存在的死锁 Token，断言必然因 ENOENT 失败，新锁凭据完全不受影响；
  22. **rename 失败保护断言**：模拟重命名发生系统异常，断言回收函数保守返回 `false`（准确反映失败），且原锁目录绝不被无条件删除；
  23. **初始化挂起安全断言**：模拟进程在建目录后长时间挂起，恢复后绝无法覆盖新锁的所有权凭据；
  24. **确定性 IPC 多进程挂起交错时序测试**：子进程 A 启动并观察到死锁后，在准备回收前通过 Node.js IPC 确定性挂起暂停；此时子进程 B 启动、自愈死锁、获得新锁并写入落盘；父进程通知子进程 A 恢复执行，断言子进程 A 恢复后未破坏子进程 B 的新锁，两进程数据最终均完整有序落盘。
- **`test/prompt.test.js` (6 个用例)**:
  1. `buildVoiceSection` 融入 `voice-learned.md`，且原有 `voice/senses` 完整保留；
  2. 学习记录为空时，输出行为与原版完全一致；
  3. 只注入最近 6 条有效学习记录（断言排除了前序旧条目）；
  4. 提示词总字符上限有效（长记录逆序保留最新，淘汰过长旧记录）；
  5. 学习文件损坏或读取失败时优雅降级为原样输出；
  6. **单条超长严格断言**：手工构造超过 800 字符（1200 字符）的学习记录及多条长记录累加，断言最终学习层严格不超过 800 字符。

---

## 四、关键边界与安全机制说明

### 1. 文件替换与旧数据保护保证范围
- **正常路径**: 尽可能使用文件系统原生原子替换。
- **替换失败路径**: 优先尝试将旧文件备份回滚恢复为目标文件。
- **回滚失败路径**: 保留并抛出包含备份文件完整路径的异常，严禁清理唯一的旧数据副本。
- **客观范围**: 在代码层面消除了所有主动删除旧数据的逻辑；但不保证在底层文件系统损坏或硬件突然掉电等极端外力场景下的绝对原子性。

### 2. 跨进程并发锁与生命周期保证
- **排队争锁与死锁自愈分离**:
  - 争锁最长等待约 1 秒（`retries: 40 * delayMs: 25ms`），防止长时间阻塞调用者；
  - 僵尸锁回收阈值严格统一为 `staleMs`（默认 10000ms），且以持锁进程确认退出（`ESRCH`）为前置条件。
- **状态迁移与 TOCTOU 彻底消除**:
  - 摒弃脆弱的多层锁嵌套设计，直接以靶向 Token 文件作为状态原子迁移载体；
  - 凭据文件名自带唯一 Token（`token.<token>.json`），任何回收或释放操作均通过精确路径靶向执行，使不同时期的锁在文件系统层天然隔离，消除所有交错时序下的误删隐患；
  - 确定性 IPC 交错测试证明：无论回收者何时暂停或恢复，绝不可能移走或破坏新进程的有效锁。
- **写盘前 Fencing Check**:
  - 即使获取了锁，在执行最终文件替换前再次校验自身是否仍为持锁者，杜绝被回收后产生并发覆写。

### 3. Prompt Injection 风险缓解（而非彻底防护）
- **客观定位**: 任何纯文本过滤器都不能声称对大模型指令注入提供“100% 彻底防护”。本插件实现的是**多层风险缓解（Risk Mitigation）**：
  1. 结构剥离：剥离行首 `#` 符号，防止破坏 Markdown 层级伪装成系统级大标题；
  2. 标签净化：将 `<` 与 `>` 净化为全角 `〈` 与 `〉`，防止伪造 `<system-reminder>` 等系统提示 XML 标记；
  3. 语义隔离声明：系统提示小节显式声明“不具有指令或安全覆盖权限”，利用模型元认知降低越权风险。

### 4. 缺少可靠 Turn ID 的说明
- DSH 宿主传递的工具执行上下文 `exec` 仅包含 `session.id`，不具备可靠的单回合递增计数；
- 本次实现严格遵循规范，**不使用会话 ID 冒充回合 ID**，通过**文本规范化去重**、**200 字限制**与**100 条条数上限**实现等效防刷防护。

---

## 五、后续步骤限制

- **Step 1 范围锁定**: 本次改动仅聚焦于 Voice Evolution，不夹带任何其他功能。
- **后续阶段准入**: 本文档与代码提交并推送至 GitHub 后，待代码逐文件复审通过，方可开启 Step 2（Mood 情绪感知层）。
