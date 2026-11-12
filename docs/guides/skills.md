**中文** | [English](skills.en.md)

# Skill 发现与读取

CLI、TUI、serve 和直接 Core 共用发现规则；连接既有服务时使用服务端目录。自动发现和显式部署（包括 Profile 引用）都只登记元信息，正文与附件按需读取当前文件；发现阶段不缓存正文，成功加载的主体作为工具结果保留在会话历史中。

| 优先级 | 目录 |
|---|---|
| 1 | `<workspace>/.agents/skills/<name>/SKILL.md` |
| 2 | `<workspace>/.claude/skills/<name>/SKILL.md` |
| 3 | `<workspace>/.codex/skills/<name>/SKILL.md` |
| 4 | `~/.agents/skills/<name>/SKILL.md` |
| 5 | `~/.claude/skills/<name>/SKILL.md` |
| 6 | `~/.codex/skills/<name>/SKILL.md` |

同名按目录名精确覆盖整个 Skill，不合并资源、不用 frontmatter name 改身份。只发现直接子目录，不向父项目递归搜索；workspace 由可信启动参数决定，不随 RPC cwd 改变。主目录与 AREAL_HARNESS_HOME 分开。

## 启动时登记元信息

每个目录含 SKILL.md，可带 references/scripts/assets。发现阶段只解析 SKILL.md 的有界 YAML frontmatter，提取 name/description；没有 frontmatter 时使用目录名和首行描述。文件头最多 32 KiB，名称最多 256 字节，描述按 UTF-8 边界截取前 4096 字节；元信息限制不用于附件或正文。模型初始提示包含名称和有界描述，不注入完整正文。

不遍历、哈希或缓存附件，取消原来的单资源 256 KiB、目录总计 2 MiB 和附件数量限制。自动发现最多登记 512 个 Skill 名称。每个搜索目录最多包含 512 个原始目录项，普通文件、隐藏项和无效目录也占用此额度。自动发现的单个 Skill 元信息损坏、入口不合法或目录链接无效时，跳过该 Skill 并输出名称、路径与原因；不回退到同名低优先级副本。搜索根本身不可访问、越界或发现数量超限仍是启动错误。显式部署清单错误仍明确失败，避免静默缺失被指定的 Skill。

GUI 与 Core 的单次部署最多登记 512 个 Skill 版本引用。GUI 把当前启用引用和仍可读取的历史引用按 `id/revision` 去重后合计，历史版本也占用此额度。超限错误显示当前数量和上限，不截断或回收历史引用。部署文件仍限 1 MiB，单次部署最多 64 个 Profile，模型提示中的 Skill 描述总预算仍为 32 KiB。显式 `selectedSkills` 最多选择 128 项。容量调整不改变 Profile、工具、审批或文件读取权限。

Skill 根目录软链接可解析到授权的项目或全局 Skill 根；SKILL.md 入口不允许软链接。可信启动器也可直接注入已解析的元信息，见[桌面契约](../api/desktop.md#skills)。

## 完整加载主体与按需读取附件

`skill_list` 与 `skill_load` 默认无需人工或模型审批。附件使用已有只读工具 `read_file` 与 `fs_read`，沿用各自的普通文件权限规则；显式 `permissions.deny`、`permissions.ask`、Profile／会话审批、工具允许列表、当前 Turn 的 Skill 范围和插件撤权仍优先。读取 Skill 不授予执行脚本、访问网络或读取任意宿主文件的权限。

`skill_list` 返回名称、描述与引用，不枚举附件；`resources` 为 null，`resourceRoot` 是受控的 `areal://skill/<id>/<revision>` 前缀。模型选定 Skill 后，先调用 `skill_load {skill:{id,revision}}` 完整加载 `SKILL.md`，再应用其中的指令。附件路径应拼接到 `resourceRoot`：文本用 `read_file` 的行/列读取，二进制或原始字节用 `fs_read`。这些 URI 只由 Core 解析，读取范围仍绑定当前 Turn 的 Skill，且始终只读；`SKILL.md` 通过普通读取工具访问会明确失败。

`skill_load` 从一次打开的文件读取完整 UTF-8 主体，返回 `{id,revision,resource:"SKILL.md",resourceRoot,sizeBytes,sha256,complete:true,text}`。包含 JSON 转义和元数据的完整响应最多 64 KiB；正文无效或超限明确失败，不返回成功的前缀。详细参考资料应移到独立文件，`SKILL.md` 保留适用条件、核心约束、执行顺序和资源导航。64 KiB 是该加载入口的资源上限，不是推荐长度，也不限制附件大小。

成功正文绕过通用工具的 16 KiB 头尾预览，原样计入工具输出及模型输入预算。首次求解请求消费前保护完整正文，不让自动摘要提前替代它；最终请求再次校验完整结果，放不下时明确停止，不扩充 Turn 或模型窗口预算。成功模型响应后沿用普通历史压缩；后续任务若仍需要已压缩的指令，应再次加载。完整交付不保证模型遵守规则，也不意味着正文在所有后续请求中永久保留。`skill_load` 不通过 `tool_program` 的选择性输出入口执行。

`skill_list.loaded` 保留兼容语义：记录成功访问过的 Skill 引用，包括主体和附件读取，不表示主体完整。新增 `loadedMain` 只列出当前历史投影中保留完整主体回执的 Skill，值为 `{revision,sha256,sourceItemId}`；它不是模型理解或遵守指令的确认，也不表示磁盘文件仍具有相同内容。压缩后不再保留完整回执时，该条目不再列出。

普通 `read_file` 对 Skill 文本附件返回标准行分页结果：`offset`/`limit`/`column` 使用 1-based 行列，`sha256` 是完整附件内容 hash，超长行用 `nextRead` 继续；结果受普通读取的有界输出预算约束。`fs_read` 返回最多 8192 字节的 `dataBase64`、完整内容 hash、`size`、`nextOffset` 与 `eof`，可用 `expectedSha256` 检查续读版本。两者都拒绝主体别名、越界路径、符号链接和写入操作。资源修改后应从新 hash 或 offset 0 重新读取，不能拼接不同版本。

公共 `areal/skill/read` 与 Rust `read_skill` 保留原有字节分页契约，供客户端和历史兼容调用使用；它不是模型的默认附件入口。显式模型工具允许列表需要加入 `skill_load`，普通 `read_file`/`fs_read` 的既有 allowlist 规则保持不变。回归验证完整交付、URI 授权、主体拒绝、普通读取语义和失败状态；模型的规则遵守率及整体任务收益须独立评测。

## 引用与升级

自动发现的 revision 为 `metadata-<SHA-256>`，只标识解析后的元信息；显式部署使用清单指定的 revision。Skill 的 id/revision 是引用标识，不保证资源字节不变，同一引用允许读取更新后的文件。Profile/Turn/队列固定所选 Skill 引用，不冻结附件。Profile 和 Workflow 定义自身仍不可变。

默认根会话使用 `areal-discovered-skills` Profile，CLI 使用 `claude-cli` 并加载 CLAUDE.md；显式 Profile 只开放其 skills。旧 CLI `claude-<name>` ID 已改为目录名，历史引用保留。历史 Skill 引用未登记时明确不可用；需要恢复这些引用时，在显式部署清单登记其原 ID/revision 和目录，读取的仍是当前文件。

Web 和 TUI 可通过 `/skills` 打开当前会话的 Skill 选择器，也可用 `/skill NAME` 直接选择。选择会以 `selectedSkills` 写入会话配置，只影响后续 Turn；空配置仍沿用 Profile 的全部 Skill。

旧持久目录中的 skillHashes 会被忽略，后续保存不再写入内容摘要。旧清单 `{id,revision,root}` 继续有效，无需指定加载模式。配置与端到端验证见[桌面示例](../examples/desktop-api.md)。
