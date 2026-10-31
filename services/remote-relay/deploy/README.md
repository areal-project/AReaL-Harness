**中文** | [English](README.en.md)

# Relay 部署

此部署使用非 root Relay/TLS 容器和独立导出的 Remote 静态客户端。源码配置不等于公网或真实设备验收；部署者仍须验证自己的 TLS、网络、设备配对与权限边界。禁止把整个桌面 renderer dist 当成公开资产。尚未测量生产容量，配置数值仅为资源上限。

## 从桌面管理服务器

桌面「设置 → 手机连接 → Relay Service」可通过系统 SSH 安装、升级、检查和移除 Relay。自动部署使用 Node 和 systemd，要求 Linux x64 或 arm64、root 或免密 sudo、已信任的 SSH 主机密钥，以及可从外网访问的 HTTPS 地址和 80/443 端口。无需 Docker。已有 Compose/nginx 手工部署仍使用下文步骤。

`managed-install.sh` 管理 `/opt/areal-relay`、`/var/lib/areal-relay` 和 `areal-relay.service`，只接管相同 owner 的实例。它从 Node 官方源下载固定版本并核对 SHA-256；公信证书由 ACME HTTP-01 自动签发并续期。自动部署不改现有防火墙或代理。端口已占用或签发失败时需核对原服务状态。

部署只向服务提交公开 room hash。capability 保留在桌面的加密配置中。SSH 中断后先检查再决定是否重试；移除默认保留数据。应用不预设官方地址，也不提供默认公网穿透。详见[Remote 指南](../../../docs/guides/remote-control.md)。

## 从公开源码构建 Remote 产物

在选定版本的干净 checkout 根目录执行，使用 Node.js 24.2.0 和 `clients/gui/package.json` 固定的 pnpm 11.7.0。`--ignore-scripts` 禁止依赖安装脚本；此静态构建不调用 Electron 安装器、Core 或原生打包入口。依赖来自公开 registry，由 `clients/gui/pnpm-lock.yaml` 固定。`REMOTE_RELEASE` 是 checkout 外的新目录，其父目录须已存在：

```sh
export REMOTE_RELEASE=/absolute/releases/remote-YOUR_SOURCE_COMMIT
mkdir "$REMOTE_RELEASE"
git rev-parse HEAD > "$REMOTE_RELEASE/source-commit.txt"
pnpm --dir clients/gui install --frozen-lockfile --ignore-scripts
pnpm --dir clients/gui build
pnpm --dir clients/gui run export:remote "$REMOTE_RELEASE/assets"
chmod -R a+rX "$REMOTE_RELEASE/assets"
cp LICENSE "$REMOTE_RELEASE/LICENSE"
cp clients/gui/THIRD-PARTY-NOTICES.md "$REMOTE_RELEASE/THIRD-PARTY-NOTICES.md"
cp clients/gui/renderer/ZCODE-LICENSE "$REMOTE_RELEASE/ZCODE-LICENSE"
cp -R clients/gui/licenses "$REMOTE_RELEASE/licenses"
cp clients/gui/pnpm-lock.yaml "$REMOTE_RELEASE/pnpm-lock.yaml"
export RELAY_ASSETS="$REMOTE_RELEASE/assets"
```

导出 CLI 读取本次构建的 `remote-assets.json`，逐文件核对 SHA-256，只复制 `remote.html` 的闭包、manifest 与 service worker；输出目录已存在或校验失败时拒绝，不合并旧版本。导出文件须可供容器 UID 1000 读取；上述权限命令只作用于公开资产，不要用于证书或私有数据。仅将 `assets` 挂载到 Relay；源码版本、锁文件和许可证保存在发布包旁，不进入公开路径。不要从运行中的另一个 checkout 复制 dist，不要额外复制 `index.html`、桌面 bundle、配置或凭据。导出后保持目录不可变，更新时生成新目录。

归档导出 CLI 返回的版本、`remote-assets.json`、Node/pnpm 版本、构建日志及所含依赖的完整许可证/归属。上面的仓库声明不替代浏览器 bundle 所含第三方依赖的许可义务；分发前根据锁文件和实际构建清单保留其原始许可文本。静态包和服务镜像必须记录为同一发布的独立制品。

## 管理员准备

使用单台 Docker Engine 主机及支持 `network_mode: service:relay` 的 Compose。操作者提供精确域名的 DNS、可信 TLS 完整证书链及私钥；片段不配置 DNS、ACME、云资源或防火墙。只发布 TCP 443，无 HTTP 监听。两个非 root 容器共享网络命名空间，后端仍在 127.0.0.1:8080。不要发布 8080 或让不可信容器加入该命名空间。TLS 容器不挂载数据库。

把 `relay.example.json` 和 `nginx.example.conf` 复制到 checkout 外，在两处一致替换 `remote.example.org`，包括精确 Host 比较和 Client Origin。保留 `listen`、`trustedLocalTlsProxy`、`/data` 及禁用 payload 日志。配置通过 JSON 文件，**没有 Relay 环境变量接口**。管理员编辑部署 JSON；最终用户通过 Host 界面接收 endpoint 和一次性登记 code。

配置文件须对相应容器用户可读。在 Linux 部署主机上，TLS 私钥为 UID/GID 101:101、0400，父目录允许遍历，不能让私钥全局可读。Relay 为 UID/GID 1000:1000。镜像中 `/data` 属于 1000:1000、权限 0700；新命名卷继承该权限，旧卷必须已经满足权限要求。不要运行 root 修复容器。只使用一个 OS 管理账号、本地文件系统和单个 Relay 实例，不跨主机共享 SQLite 卷。

在本目录为 shell 设置以下 **Compose 插值变量**，也可放在私有 Compose env 文件中：

```sh
export RELAY_IMAGE=areal-remote-relay:YOUR_SOURCE_COMMIT
export RELAY_CONFIG=/absolute/private/relay.json
export RELAY_ASSETS=/absolute/releases/remote-YOUR_SOURCE_COMMIT/assets
export NGINX_CONFIG=/absolute/private/nginx.conf
export TLS_CERT=/absolute/private/fullchain.pem
export TLS_KEY=/absolute/private/privkey.pem
docker compose config --quiet
docker compose build relay
docker compose up -d relay
docker compose run --rm --no-deps tls -t
docker compose up -d
```

不能忽略证书或配置错误。`docker compose config` 只验证 Compose 结构。健康检查向 loopback `/healthz` 发送配置中的精确 Host，不证明 TLS 或登记正常。向用户开放前，用真实客户端验证证书、WSS、错误 Host/Origin 拒绝、明文拒绝及外部无法访问 8080；审查渲染配置与实际监听端口。镜像固定版本及归属见[第三方归属](THIRD-PARTY.md)。

两个容器根文件系统只读，`/tmp` 为有界 tmpfs。Node 为 PID 1，直接接收 SIGTERM，通过已有关闭流程释放锁。NGINX 使用单 worker，PID/临时文件位于 `/tmp`。禁用 access log，丢弃可能包含秘密 URL 的 NGINX error log；通过退出状态和私有主动健康检查诊断，因此缺少代理错误详情。不通过自动重启掩盖残留锁。

## Host 登记与设备配对

管理员验证入口后，通过下节本地 CLI 生成一次性 code，将精确 HTTPS origin 与 code 私密交给 Host 使用者。在桌面「设置 → 手机连接」填写 Relay origin 和 code，确认信任并启用。Host 将 capability 保存到安全存储；安全存储不可用时拒绝启用。连接成功后选择 Relay 配对传输，点击「配对新手机」，用手机扫描链接，再回到桌面核对完整设备指纹、已有项目范围和 Observer/Operator 预设，明确确认后才授予访问。

设备授权区可修改范围或撤销设备；Relay 管理员也可用下节 `revoke` 禁用整个 Host room。二者分别属于 Host grant 与 Relay 登记。切换 origin 需要重新登记和配对，不迁移浏览器私钥。Host/Core 重启后客户端重新取基线，未知提交不能自动重放。个人用户可选择 Direct，无需部署此服务。具体公开界面与恢复行为见[连接指南](../../../docs/guides/remote-control.md)；这些步骤不要求厂商账号、Core token、用户修改产品 JSON 或公开 Core 端口。

## 本地管理和私有备份

在本目录使用相同 Compose 变量。不要把 enrollment 输出放入共享日志。code 十分钟过期且只用一次。Host capability 保存在 Host 安全存储，不进入手机邀请。不涉及 Core token 或公开 Core 端口。

```sh
docker compose exec -T relay node src/cli.mjs enrollment --config /config/relay.json
docker compose exec -T relay node src/cli.mjs revoke ROOM --config /config/relay.json
# 每次选择新备份文件名；已有目标被拒绝。
docker compose exec -T relay node src/cli.mjs backup /data/backup.sqlite --config /config/relay.json
umask 077
docker compose cp relay:/data/backup.sqlite ./backup.sqlite
chmod 600 ./backup.sqlite
```

备份不得进入公开资产或源码版本控制，只包含登记/room 元数据，没有对话历史。独立维护私有撤销清单。Relay room 撤销与 Host 设备 grant 撤销是不同操作。

可信备份已位于 `/data/backup.sqlite` 时，通过受支持的恢复命令处理，不直接覆盖数据库：

```sh
docker compose stop tls relay
docker compose run --rm --no-deps relay restore /data/backup.sqlite --config /config/relay.json
docker compose up -d --force-recreate relay tls
```

外部备份可在两个服务停止后，以 Relay 用户导入新文件（拒绝已有文件）：

```sh
docker compose run --rm --no-deps -T --entrypoint node relay -e 'require("node:fs").writeFileSync("/data/import.sqlite",require("node:fs").readFileSync(0),{mode:0o600,flag:"wx"})' < ./backup.sqlite
```

恢复命令此时使用 `/data/import.sqlite`，文件保持 1000:1000 所有权。不要执行 `down -v`。restore 在 checkpoint/原子替换前禁用恢复出的**全部** Host 和 enrollment。核对撤销清单，生成新登记 code，复核 grant 后才恢复路由。数据库错误必须关闭访问，不存在匿名回退。

崩溃可能留下 `server.lock` 或 `admin.lock`。先停止两个服务和所有一次性管理容器，再检查锁。PID 属于容器命名空间且可复用，单独 PID 不能证明进程是否存活。独立确认所有服务/管理进程都未打开该卷后，才使用非 root 一次性 Relay 容器删除残留锁和被中断的 `restore.sqlite`、`restore.sqlite-wal`、`restore.sqlite-shm`。不能删除 `relay.sqlite-wal` 或 `relay.sqlite-shm`。见[服务恢复规则](../README.md)。checkpoint 失败时保留损坏卷，在新的私有卷中恢复可信备份。

## 升级、回滚和静态资产

记录源码 commit、构建镜像 ID/digest、两个基础镜像 digest、配置 hash 和实测容量（当前未测）。保留上一版本地镜像。先停止 TLS，阻止新登记并断开 socket，通过 Relay 在线备份，再停止 Relay。把 `RELAY_IMAGE` 改为新版本，构建并重建**两个**容器，确保 TLS 加入新的网络命名空间。客户端自行重连，不保留命令队列。分发登记 code 前验证健康检查和真实 TLS/WSS。

仅向协议/数据库 schema 兼容的保留镜像回滚，使用当前数据库，不因代码回滚而倒退数据库。必须恢复数据时，执行上述全部禁用恢复并重新登记，不能降级鉴权或跳过撤销复核。本片段未证明回滚兼容性。

Compose 要求 `RELAY_ASSETS` 指向已导出的 Remote 目录，以只读 bind 挂载到 Relay `/assets`，样例 JSON 设置 `assetsDir: "/assets"`。缺失目录不会自动创建；TLS 容器不接触静态目录或数据库。升级时一并切换与服务兼容的完整静态版本，再重建两个容器；回滚须同时保留对应静态产物。检查 `/`、manifest、service worker 和实际模块的版本/hash、CSP 与 MIME/no-store/no-referrer 头，并确认桌面入口、管理路由、未知文件及路径穿越请求均被拒绝。不要通过放宽 CSP 或绕过证书检查消除错误。
