**中文** | [English](skills.en.md)

# Skill 发现与读取

CLI、TUI、serve 和直接 Core 共用发现规则；连接既有服务时使用服务端目录。自动发现和显式部署（包括 Profile 引用）都只登记元信息，正文与附件按需读取当前文件，不创建内容快照。

| 优先级 | 目录 |
|---|---|
| 1 | `<workspace>/.agents/skills/<name>/SKILL.md` |
| 2 | `<workspace>/.claude/skills/<name>/SKILL.md` |
| 3 | `~/.agents/skills/<name>/SKILL.md` |
| 4 | `~/.claude/skills/<name>/SKILL.md` |

同名按目录名精确覆盖整个 Skill，不合并资源、不用 frontmatter name 改身份。只发现直接子目录，不向父项目递归搜索；workspace 由可信启动参数决定，不随 RPC cwd 改变。主目录与 AREAL_HARNESS_HOME 分开。

## 启动时登记元信息

每个目录含 SKILL.md，可带 references/scripts/assets。发现阶段只解析 SKILL.md 的有界 YAML frontmatter，提取 name/description；没有 frontmatter 时使用目录名和首行描述。文件头最多 32 KiB，名称最多 256 字节，描述按 UTF-8 边界截取前 4096 字节；元信息限制不用于附件或正文。模型初始提示包含名称和有界描述，不注入完整正文。

不遍历、哈希或缓存附件，取消原来的单资源 256 KiB、目录总计 2 MiB 和附件数量限制。发现目录仍最多 128 个 Skill、每搜索目录最多 256 项。自动发现的单个 Skill 元信息损坏、入口不合法或目录链接无效时，跳过该 Skill 并输出名称、路径与原因；不回退到同名低优先级副本。搜索根本身不可访问、越界或发现数量超限仍是启动错误。显式部署清单错误仍明确失败，避免静默缺失被指定的 Skill。

Skill 根目录软链接可解析到授权的项目或全局 Skill 根；SKILL.md 入口不允许软链接。可信启动器也可直接注入已解析的元信息，见[桌面契约](../api/desktop.md#skills)。

## 按需读取当前文件

`skill_list` 返回名称、描述与引用，不枚举附件；`resources` 为 null。Agent 按需要通过 `skill_read` 读取 SKILL.md，再跟随其中的相对路径读取资源。每次异步读取最多 8192 字节，使用 offset/nextOffset 分页；文件大小不受该分页上限限制。二进制以 base64 返回，不自动变成模型图像输入；附带脚本不自动执行。

读取从登记时打开的根目录描述符逐段定位，拒绝绝对路径、父目录跳转、内部文件/目录软链接和特殊文件。坏附件仅使该次读取失败，不影响其他 Skill。正文与附件的编辑、新增、删除在后续读取生效；元信息索引在重新登记或重启后更新。跨页读取不保证文件内容不变；需一致内容时由部署方提供只读版本目录。

## 引用与升级

自动发现的 revision 为 `metadata-<SHA-256>`，只标识解析后的元信息；显式部署使用清单指定的 revision。Skill 的 id/revision 是引用标识，不保证资源字节不变，同一引用允许读取更新后的文件。Profile/Turn/队列固定所选 Skill 引用，不冻结附件。Profile 和 Workflow 定义自身仍不可变。

默认根会话使用 `areal-discovered-skills` Profile，CLI 使用 `claude-cli` 并加载 CLAUDE.md；显式 Profile 只开放其 skills。旧 CLI `claude-<name>` ID 已改为目录名，历史引用保留。历史 Skill 引用未登记时明确不可用；需要恢复这些引用时，在显式部署清单登记其原 ID/revision 和目录，读取的仍是当前文件。

旧持久目录中的 skillHashes 会被忽略，后续保存不再写入内容摘要。旧清单 `{id,revision,root}` 继续有效，无需指定加载模式。配置与端到端验证见[桌面示例](../examples/desktop-api.md)。
