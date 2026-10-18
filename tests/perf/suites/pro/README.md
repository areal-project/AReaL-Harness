**中文** | [English](README.en.md)

# pro：harness-bench-terminal

20 道题使用仓库内的 Dockerfile 和初始输入构建，无需内部 registry、EnvArena 或 OSS 凭据。构建与评分入口见[基准测试](../../../../docs/benchmarks/README.md#suites)。

```sh
./scripts/perf fetch-pro
./scripts/perf build-pro --case tbpc002004-match-device-observation-lines
# 省略 --case 构建全部；可重复传入以选择子集。
```

`run --task pro` 自动构建所选题目的环境，再安装 runner；构建不计入解题时间。`build-pro` 不调用模型。基础镜像固定到公开 Docker Hub 的 amd64 manifest；构建需要访问公开软件源，离线运行前先完成构建。

| 路径 | 内容 |
|---|---|
| [benchmark.json](benchmark.json) | 原始 Benchmark 版本、摘要、有序 Env 引用与权重 |
| `cases/<id>/env.json` | 脱敏的 Env 来源记录；历史镜像地址使用 `source.invalid` 占位，不会被拉取 |
| `cases/<id>/environment/Dockerfile` | 单题公开构建配方；context 仅为该 environment 目录 |
| `cases/<id>/environment/resources/` | 原镜像的初始题目输入、未完成实现；不包含 oracle |
| `cases/<id>/environment/origin.json` | 原镜像身份、脱敏前后的 Env 摘要和初始文件校验值 |
| `cases/<id>/task.toml` | 本地构建、资源与评分配置 |
| `cases/<id>/prompt.md`, `oracle/` | 原题面和隐藏测试；测试仅在 Agent 退出后注入 |

也可独立构建单题：

```sh
docker build --platform linux/amd64 -t observation-lines:local \
  tests/perf/suites/pro/cases/tbpc002004-match-device-observation-lines/environment
docker run --rm --platform linux/amd64 observation-lines:local \
  cat /app/public/corpus.txt
```

## 环境与评分边界

公开配方保留初始题目物料，移除内部沙箱服务、内部证书及与题目无关的旧 `/testbed`。通用题使用公开 Python/GCC 基础镜像；迁移题固定 Debian 软件包并校验评分器要求的运行时文件；数值题固定 AlmaLinux Python RPM 与 NumPy wheel 哈希。Git 快照题保留原始对象和引用；C 共享库的初始失败实现从源码编译。三道原本为空的工作区仍为空。

`origin.json` 记录的是原始输入身份。重新编译的 C 二进制、系统工具版本和镜像 ID 可以不同，因此公开重建环境不等同于历史私有镜像，不复用旧性能结论。严格运行库校验失败时应修复构建依赖，不得绕过评分器校验。复制材料保留原有版权、canary 与许可证说明，并遵循各自的许可条款。

历史镜像的 registry 与命名空间已脱敏；标签、镜像摘要及题目输入保持不变。`source_env_sha256` 校验仓库内脱敏后的 `env.json`，`unredacted_source_env_sha256` 保留脱敏前文件的摘要；`content_hash` 仍是来源平台记录的摘要，不表示脱敏文件的哈希。

国际象棋题的 oracle 随附 `chess 1.11.2`，使用 GPL-3.0-or-later；[来源记录](cases/tbpc030001-enumerate-legal-chess-successors/oracle/vendor/chess/PROVENANCE.txt)与[上游许可证](cases/tbpc030001-enumerate-legal-chess-successors/oracle/vendor/chess/LICENSE.txt)一并保留。它属于基准评分材料，不随 Harness 产品二进制打包。第三方材料不因本仓库的 Apache-2.0 许可证而改用 Apache-2.0。

`areal-pro-strict-v1` 要求非空测试全部通过且无跳过才得 1。Agent 与 grader 使用同一个独占容器；模型凭据只进入网关。统一限制为 2 CPU、4 GiB、512 PID，Agent 超时来自 Env，grader 超时 7200 秒；不能直接等同平台 core-only 评分。

`environment.build` 指向独立构建目录，`environment.image` 是本地 tag 前缀，实际 tag 追加构建摘要；原来的内部镜像配置已替换。严格运行库在安装 runner 后再次校验。

更新题目时同步来源、输入、构建配方和 oracle。构建缓存包含配方、资源与可执行位；报告记录公开环境镜像 ID 和构建摘要。环境变化后创建新批次，不恢复历史私有镜像批次。
