# 市场 v0 静态站点——目录的线上家

> [English](README.md) | 简体中文

市场 v0 是**一份签名的静态 `index.json` 加普通文件托管上的包 tgz**(契约提案
contract/proposals/2026-10-01-plugin-marketplace.md 模型规则 1:目录是数据,
不是服务)。本目录是该站点在 owner 服务器上的托管套件:nginx 站点配置、
一条命令的发布器、目录生成/签名器,以及一份样例载荷(对仓库真实
`system-plugins/` 产出的**真签名** index,签名用一次性**测试**密钥对——按需
生成、绝不入库)。

## 布局

```
deploy/marketplace/
├── README.md / README.zh.md   本双语对
├── generate-index.mjs         目录工具:--keygen / --build / --verify
├── catalog.json               每插件的双语摘要(人工维护,漂移即响亮失败)
├── nginx.conf.example         静态站点(内容类型+缓存头,无目录列表)
├── deploy.sh                  rsync 发布 + 原子替换 index(必须给 DEPLOY_HOST)
└── site/                      站点根:index.json + packages/*.tgz(样例载荷)
```

## 状态(2026-10-01):待机——服务器不可达

探活已带证据执行,结论如实:**本机连不上服务器,也没有凭据**。没有部署,
也绝不声称部署了。

| 探测(BatchMode,ConnectTimeout) | 结果 |
| --- | --- |
| `ssh root@1.1.1.1` 直连 ×3 | `Operation timed out` ×3 |
| 走 `-o ProxyCommand="nc -x 127.0.0.1:7890 %h %p"` ×3(另加 2 次 10 秒超时) | TCP 经代理能建立,但每次都 `Connection timed out during banner exchange`——该路径上没有 SSH 服务应答 |
| 裸 TCP `nc -z` 直连/走代理 | 直连失败;走代理 `succeeded`(TCP 通,但随后无 SSH banner) |
| 凭据 | `~/.ssh` 无任何私钥(无 `id_*`),无 `config`;`known_hosts` 只有 `github.com`——本机从未与该主机完成过 SSH 握手 |

shell 历史显示 owner 此前用过 `ssh root@1.1.1.1 -o Proxycommand="nc -x
127.0.0.1:7890 %h %p"`(本地 Clash 7890)——该路线已保留为 deploy.sh 的
`DEPLOY_PROXY`,但没有密钥、对端也没有 sshd 应答,无从部署。

## Owner 需要提供的事(待机清单)

1. **主机 + SSH 密钥**——真实主机/IP,以及本机的授权公钥
   (`ssh-keygen -t ed25519`,公钥放进服务器 `authorized_keys`)。然后
   `export DEPLOY_HOST=<host>`(按需加 `DEPLOY_USER`/`DEPLOY_PORT`/
   `DEPLOY_IDENTITY`/`DEPLOY_PROXY`)。
2. **安全组放行 80/443**——阿里云上,实例安全组须放行入站 TCP 80 与 443
   (发布时还需从部署机 IP 放行 22)。
3. **域名,以及 TLS:建议 caddy 或 certbot**——市场应以 HTTPS 访问
   (签名 index 里的 `tgzUrl` 是绝对地址)。二选一:
   - **caddy**(推荐,配置最少):域名指向服务器,caddy 监听 443 并
     `reverse_proxy 127.0.0.1:80`——证书全自动;或
   - **certbot**:`certbot --nginx -d <域名>` 会给 nginx 配置补上 443 块和
     自动续期。

## 发布(等服务器就绪后)

```sh
node generate-index.mjs --keygen test-keys/test-ed25519   # 一次,仅本地——任何密钥都不入库
node generate-index.mjs --build --plugins ../../system-plugins \
  --catalog catalog.json --key test-keys/test-ed25519.pem \
  --key-id dsh-market-test-1 --base-url https://<你的域名> --out site
node generate-index.mjs --verify site/index.json   # 签名+摘要
DEPLOY_HOST=<host> ./deploy.sh                     # rsync + 原子替换 index
DEPLOY_HOST=<host> ./deploy.sh --dry-run           # 先预演
curl -fsSL https://<你的域名>/index.json | head    # 发布后检查
```

index 是**生成的**,绝不手改:每个 `tgzUrl` 都被签名进目录,换域名(或换
钥)意味着重新生成 + 重签 + 重新发布。没有 `DEPLOY_HOST` 时 deploy.sh 一键
待机、响亮失败——这是设计,不是要绕过的错误。

## 密钥——发布任何真实内容前必读

- **本仓库不存任何密钥——测试对也不存。** `site/` 里的样例载荷是真签名
  (而非占位),出自一次性测试密钥对(`dsh-market-test-1`),它有意不入树:
  仓库的既定纪律是任何密钥绝不提交(`.gitignore` 的 `*.pem`——"任何 token、
  密钥不入库")。用上面的 `--keygen` + `--build` 可本地复现完整流程;验证
  **已提交的样例**完全不需要钥——公钥就在 `index.json` 的 `keys{}` 里,
  新克隆上直接跑 `--verify` 即可。测试钥不保护任何东西;生产流量绝不要
  指到它们。
- **生产签名密钥放 CI secrets**(GitHub Actions 环境级 secret,构建时以
  文件形式落盘)。绝不提交进仓库,也绝不拷贝到托管服务器——服务器在设计上
  就是不可信托管(提案正是为了"被攻破的服务器也伪造不了目录"才拒绝纯传输
  信任;保住这条性质)。
- **验证公钥钉在宿主侧**(App 构建配置/仓库配置,与 vendor pin 表同一纪律):
  index 的 `keys{}` 块承载裸 ed25519 公钥,base64。
- **轮换走双签窗口**(提案规则:轮换期发布新旧两钥双签的 index,窗口结束后
  撤下旧钥)。`--key-id` 指明签名用的钥。

## 站点契约(nginx.conf.example 保证的事)

- `/index.json` → `application/json`,`Cache-Control: public, max-age=60`
  (短缓存:换钥与新条目几分钟内生效;客户端 resolver 另有自己的缓存策略)。
- `/packages/<pkg>@<semver>.tgz` → `application/gzip`,
  `Cache-Control: public, max-age=31536000, immutable`(带版本的 tgz 永不变,
  新版本即新文件)。index 里的 `blobSha256` 才是完整性锚——缓存头只为传输效率。
- 无目录列表(`autoindex off`)、无 HTML,其余一律 404,全局
  `X-Content-Type-Options: nosniff`。
- 包只增量发布(`--ignore-existing`,不用 `--delete`):已安装的设备可能仍
  引用旧版本;增长的只有磁盘,定期清理是明确的人为动作。
