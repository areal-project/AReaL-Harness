# 维护设计规则

规则元数据位于 [rule-registry.json](rule-registry.json)。`registry.json`通过 `ruleRegistry` 指向它。每个条目记录稳定 ID、标题、唯一 owner、规则强度与正文 SHA-256。正文仍在拥有该决定的文档中，登记表不复制规则全文。

## 定义与引用

`R-RULES-001` 正文用可读的 `R-域-编号` 前缀声明 ID；既有 CONV/SET/WT 等带冒号的 ID 直接作为定义，不重复添加注释。`owner` 指向既有标题锚点。引用使用 ID 和 owner 链接。强度分别记为 `must`、`default` 和 `explore`。改写规则时更新原定义和登记摘要。

## 文档角色与迁移

`R-RULES-003` [document-inventory.json](document-inventory.json)逐文件登记使用者、维护者、跨产品原则或过程证据。`active`、`generated`、`redirect`、`archived`分别表达现行文档、生成参考、旧入口和历史证据。GUI 专属现行合同迁到 GUI 目录；真实练习、研究和单次结果进入归档。旧路径与标题锚点保留一个迁移周期。当前合同不得为了字节指标进入归档。
