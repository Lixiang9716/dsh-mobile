# IdP 一键待机包(市场 v2 —— 发布者身份服务)

> [English](README.md) | 简体中文

**状态:待机 —— 未部署。** 部署目标探活结果为**不可达:缺凭据**(2026-10-01)。
下述内容均已备好可跑;但没有任何一处声称服务器应答过。凭据到位后,`deploy.sh`
即可把本包变成带健康检查的真实部署——在此之前它只是配置即数据,不触碰
`runtime/` 与 `contract/`。

探活原文(2026-10-01 运行,`deploy/idp/deploy.sh --host root@1.1.1.1 --check-only`,
直连与 `--proxy 'nc -x 127.0.0.1:7890'` 各数轮;`~/.ssh` 无私钥,`ssh-add -l` 无身份):

```
=== 手工轮次(ssh BatchMode) ===
直连:   ssh: connect to host 1.1.1.1 port 22: Operation timed out        (exit 255,2 轮)
代理:   Connection timed out during banner exchange                      (exit 255,3 轮)
        Connection to UNKNOWN port 65535 timed out
TCP:    直连 1.1.1.1:22            -> 失败(nc exit 1)
        经 SOCKS5 127.0.0.1:7890   -> TCP 可建连,但 SSH banner 始终未到达
=== deploy.sh 探活(交付工具本体) ===
[deploy-idp] PROBE FAILED — unreachable: missing credentials or host down
[deploy-idp] --- raw ssh stderr ---
ssh: connect to host 1.1.1.1 port 22: Operation timed out      (直连,exit 3)
Connection timed out during banner exchange                    (代理,exit 3)
```

## 包内清单

| 路径 | 角色 |
| --- | --- |
| `logto/docker-compose.yml` | **首选目标** —— Logto `1.44.0`(已钉版)+ Postgres,端口仅绑回环,占位符来自 `.env` |
| `logto/env.example` | 占位符模板 —— 在**主机上**复制为 `.env`,绝不入库 |
| `pocketbase/pocketbase.service` | **备选目标** —— 单二进制 systemd 单元模板(路径由 `deploy.sh` 安装时烘焙;资源紧张主机) |
| `deploy.sh` | 参数化部署 + 健康检查(`--host`、`--port`、`--proxy`、`--remote-dir`、`--target logto\|pocketbase`、`--check-only`) |

## 选型说明(摘要 —— 完整版见 Agent Note)

- **Logto 首选**:市场提案
  ([contract/proposals/2026-10-01-plugin-marketplace.zh.md](../../contract/proposals/2026-10-01-plugin-marketplace.zh.md)
  的"演进 v2")点名 OIDC IdP "Logto-class,TS,可自托管"。Logto 是
  TypeScript——与本仓 runtime、web client 同栈;说标准 OIDC(发现端点
  `/oidc/.well-known/openid-configuration`),自带管理控制台。来源:
  [Logto OSS 文档](https://docs.logto.io/logto-oss/get-started-with-oss)、
  [部署与配置](https://docs.logto.io/logto-oss/deployment-and-configuration)。
- **PocketBase 备选**(单二进制,占用极小):如实注明 —— PocketBase 是
  OIDC *客户端*,**不是**原生 OIDC issuer
  ([认证文档](https://pocketbase.io/docs/authentication)、
  [讨论 #4861](https://github.com/pocketbase/pocketbase/discussions/4861))。
  受限主机上它提供身份存储 + 认证 API;若 v2 集成在该主机上必须说 OIDC,
  应改落 Logto(或专用轻量 IdP)。
- **Keycloak / Zitadel 不选**:Keycloak 的 JVM 占用对单租户发布者服务过重;
  Zitadel 能力足够但 gRPC 优先,给纯 OIDC 的 v2 面增加不需要的客户端负担。
  两者都败给 Logto 的同栈对齐。

## Owner 需提供(checklist)

1. **主机** —— 可 SSH 的 Linux 服务器。Logto 按
   [OSS 文档](https://docs.logto.io/logto-oss/get-started-with-oss)
   规格准备(2 vCPU / 8 GiB RAM 档),装好 Docker + compose 插件;
   PocketBase 任意小机器可跑单二进制。
2. **密钥** —— 操作者账号的 SSH **密钥对**,公钥装到主机。`deploy.sh`
   仅用 BatchMode:命令行无口令,git 无密钥。若出网需走 SOCKS 代理,
   把代理地址给 `--proxy`。
3. **安全组** —— 入站 `80/tcp` + `443/tcp`(公网;OIDC 回调来自浏览器)、
   `22/tcp` 限操作者网络。**不要**暴露 `3001/3002/8090` —— 本包所有服务
   只绑回环,TLS 终止在反向代理。
4. **域名** —— Logto 需要两个 DNS 名(`ENDPOINT`,如 `idp.example.com`;
   `ADMIN_ENDPOINT`,如 `idp-admin.example.com`),均指向主机,TLS 由代理
   终止。未来依赖方的 OIDC 回调域名在 Logto 管理控制台内登记——
   `logto/env.example` 的占位符标明了它们的位置。

## 部署(凭据到位后)

```sh
# 仅探活 —— 安全,不做任何变更
./deploy.sh --host USER@HOST --check-only

# 完整部署,Logto
./deploy.sh --host USER@HOST --target logto --proxy 'nc -x 127.0.0.1:7890'

# 完整部署,PocketBase 备选
./deploy.sh --host USER@HOST --target pocketbase
```

`deploy.sh` 若发现 `.env` 缺失,会在**主机上**生成 Postgres 口令(600 权限
的 `.env`,hex 编码——在 `postgresql://` URL 内安全);已存在的 `.env`
绝不覆盖,且文件同步整体排除 `.env`——即使本地残留副本也到不了主机。

## 首启 —— 初始管理员(口令绝不入 git)

- **Logto**:打开 `ADMIN_ENDPOINT`;欢迎页提供 **Create account**——在浏览器
  里当场设置管理员用户名与口令。OSS 控制台仅支持一个管理员账号。来源:
  [Logto OSS 文档](https://docs.logto.io/logto-oss/get-started-with-oss)。
- **PocketBase**:打开 `https://<host>/_/`,在 Web 安装器里创建超级用户。
  不要用带口令的 shell 命令行创建。

两种口令都不写进 git、聊天、工单或 shell 历史。Logto 管理员丢失可通过
重新种子恢复;但请把首启口令当作资产对待。

## HTTPS(建议:caddy)

两个目标都只绑回环;TLS 放在前置代理。把这份 `Caddyfile` 放到主机:

```
idp.example.com {
  reverse_proxy 127.0.0.1:3001
}
idp-admin.example.com {
  reverse_proxy 127.0.0.1:3002
}
# pocketbase 备选:一个域名,reverse_proxy 127.0.0.1:8090
```

compose 文件已为此拓扑设置 `TRUST_PROXY_HEADER=1`。来源:
[caddyserver.com](https://caddyserver.com)、
[Logto 反向代理说明](https://docs.logto.io/logto-oss/deployment-and-configuration)。
