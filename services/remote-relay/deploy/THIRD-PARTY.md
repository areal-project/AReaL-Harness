**中文** | [English](THIRD-PARTY.en.md)

# 部署来源与许可证

| 组件 | 固定来源 | 许可证与保留声明 |
|---|---|---|
| AReaL Relay | 构建使用的源码 commit，随镜像 ID 记录 | Apache-2.0，`licenses/AREAL-LICENSE` |
| Cindy ACME、CSR 与证书管理 | [Cindy](https://github.com/makecindy/cindy/tree/7d7473c62d17b0a893fa503d8a42e35c34ae02d1)，修改为原生 JavaScript 与可取消生命周期 | Apache-2.0，`licenses/CINDY-LICENSE` 与 `licenses/CINDY-NOTICE` |
| Node.js | 24.2.0，[上游](https://github.com/nodejs/node/tree/v24.2.0) | MIT 及所含组件声明，上游完整 `licenses/NODE-LICENSE` |
| ws | 8.21.3，npm tarball 与 integrity 位于 `../package-lock.json` | MIT，`licenses/WS-LICENSE`；npm 同时保留 `node_modules/ws/LICENSE` |
| NGINX | 1.30.5，[上游](https://github.com/nginx/nginx/tree/release-1.30.5) | BSD-2-Clause，`licenses/NGINX-LICENSE` |
| NGINX 非特权镜像构建文件 | [588b4cbc88065a313909f47a02510639e01cc508](https://github.com/nginx/docker-nginx-unprivileged/tree/588b4cbc88065a313909f47a02510639e01cc508) | Apache-2.0，`licenses/NGINX-IMAGE-LICENSE` |

以下基础镜像索引 digest 已通过 Docker Hub Registry v2 元数据核对：

- `node:24.2.0-bookworm-slim@sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89`
- `nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3`

Registry 端点为 `https://registry-1.docker.io/v2/library/node/manifests/24.2.0-bookworm-slim` 和 `https://registry-1.docker.io/v2/nginxinc/nginx-unprivileged/manifests/1.30.5-alpine`（需要公开 pull bearer 认证）。这些是多平台索引 digest，实际构建/部署时还需记录平台与子 digest。tag 可变；digest 固定来源，不代表当前漏洞评估。

Node 镜像还包含 Debian Bookworm 软件包与 npm，代理镜像包含 Alpine 软件包与 NGINX 模块；它们遵循各自许可证，不采用 Relay 许可证。保留基础镜像许可文件、Debian `/usr/share/doc/*/copyright`、npm 所含声明和 Alpine 软件包元数据；参见 [Debian 版权信息](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information)、[Alpine 软件包索引](https://pkgs.alpinelinux.org/packages)及[官方 Node 镜像源码](https://github.com/nodejs/docker-node)。分发镜像前生成所选平台的 SBOM/软件包清单，满足对应源码/声明义务。本源码归属清单不等于所选平台构建镜像的 SBOM。

构建 context 由服务 `.dockerignore` 限定，Dockerfile 只复制依赖清单/lockfile、五个 Relay 源码模块、健康检查和声明，不包含 GUI/Core、本机配置、证书、数据库、测试或研究档案。依赖通过 `npm ci --omit=dev --ignore-scripts` 安装，不内嵌静态资产；Remote 专用产物独立导出并只读挂载，其来源、锁文件和许可随发布包保存。构建、公开产物边界与部署检查见[运维说明](README.md)。
