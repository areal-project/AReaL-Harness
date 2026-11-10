---
name: remove-compat
description: 删除兼容旧数据、旧协议、旧界面的过渡代码。产品处于前期 Beta、不支持降级，用一次停机导入替代长期双实现。
---

# 删兼容

## 先确认能删

1. 找到过渡代码的注释“过渡：到 <版本> 删”，或 `scripts/check-transitional-baseline.json` 里登记的文件。
2. 确认新实现已覆盖所有调用方：`git grep` 旧名字，包括 Rust、TS、脚本、文档和测试清单。
3. 旧数据怎么办：由一次性导入（升级时停机导入）负责，不在运行时同时读新旧两种格式。导入缺证据的记录只标 UNKNOWN，不阻塞升级。

## 删

- 同一个 PR 里删：旧实现、只为它存在的开关、它的测试与夹具、它的文档段落。不留“以防万一”的分支。
- 不写新旧实现对照测试；新实现的行为测试已经覆盖就够了。
- 改 Core Store 格式或迁移契约、移动数据目录要先问用户。

## 收尾

- `python3 scripts/check-transitional.py --write` 收紧过渡代码登记；`python3 scripts/check-references.py --write` 收紧无入口脚本登记。
- `make check-changed`；有失败用 `make baseline-diff` 判断是不是本次造成。
- 汇报写清删了什么、旧数据由谁接手、哪些用户路径在什么环境验过。
