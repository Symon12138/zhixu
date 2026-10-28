# 知序 · 单节点公网版运维手册

本手册面向部署与运维「知序」公网单节点正式版的工程师。请先读完「单节点边界」再开始部署——这决定了哪些运维动作是安全的、哪些会静默破坏用户数据。

> 本仓库开发机没有安装 Docker CLI。`docker-compose.yml`、`Dockerfile`、`deploy/nginx.conf` 与本文的 Docker 命令只做了静态一致性回归（`tests/deployment-config.test.ts`），**未在本机实际执行 build / up / certbot**；CI 同样只跑离线检查，不执行 docker build / compose up / certbot / nginx。首次上线必须按第 13 节在目标主机逐项验证。

## 1. 单节点边界（先读）

- 本应用是**单节点部署**：一个进程 + 一个 SQLite 文件（WAL 模式）。所有认证、会话、额度、学习数据都落在这台机器的 `ZHIXU_DATA_DIR` 中。
- **不要声称多实例能力**：
  - 登录会话存 SQLite，理论上第二实例可以读到，但额度扣减、备份、迁移和乐观并发设计都以「唯一写入者」为前提。启动第二个写实例会产生锁竞争和数据损坏风险。
  - 数据库文件不要同时被两个进程打开写（包括备份脚本在恢复时直接打开生产库）。
  - 不要把单机 SQLite 目录挂到 NFS 或多容器共享卷上「横向扩展」。
- 扩容路径是**纵向**（更大机器）+ 数据目录定期备份，不是加副本。当前版本没有内置分布式或主从复制。
- `docker-compose.yml` 定义了一个应用容器和一个 nginx；certbot 只在 `tls` profile 下按需运行，不是常驻服务。`restart: unless-stopped` 提供进程级自愈，不是高可用。

## 2. 环境与密钥清单

所有变量见 `.env.example`。以下部署变量由 Docker Compose 读取，应用进程会忽略：

| 变量 | 说明 |
| --- | --- |
| `ZHIXU_IMAGE` | 应用镜像的完整引用，**必须带明确版本**（如 `zhixu-study:1.0.0`），禁止 `latest`。升级/回滚改这一项 |
| `ZHIXU_TLS_DOMAIN` | 证书域名，必须与 `ZHIXU_PUBLIC_ORIGIN` 和 nginx `server_name` 一致 |
| `ZHIXU_ACME_EMAIL` | Let's Encrypt 注册与到期通知邮箱 |

应用变量：

| 变量 | 说明 |
| --- | --- |
| `ZHIXU_PUBLIC_ORIGIN` | 对外完整 https 地址，如 `https://study.example.com` |
| `ZHIXU_HOST` / `ZHIXU_PORT` | 容器内监听 `0.0.0.0:3001`，仅供 internal 网络 nginx 访问；非 Docker 部署用 `127.0.0.1:3001` |
| `ZHIXU_TRUST_PROXY` | 正式部署**必须为 true**（`npm run check:production` 会强制检查），信任一层 nginx 的 `X-Forwarded-For`；否则全站共用代理 IP 的限流桶 |
| `ZHIXU_AUTH_REQUIRED` | **必须为 true**（或不设置，默认开启）。禁止设为 false 上公网 |
| `ZHIXU_ALLOW_BYOK` | 是否允许登录用户保存个人模型/搜索密钥。默认 false，只用服务端密钥；开启后个人配置加密保存在 `user_credentials` 表，每账户一行，只有该账户可读取。登录后的模型 Key 必填，搜索 Key 仅在发起联网搜索时需要（You.com 可留空 Key 使用免费接口）；缺少所需个人 Key 会返回 409，不会回退服务端共享 Key。加密密钥为 `ZHIXU_DATA_DIR/credentials.key`，备份数据库时必须同时备份 |
| `ZHIXU_BYOK_BASEURLS` | BYOK 开启时允许的 OpenAI 兼容端点 origin 白名单；官方 `https://api.openai.com` 始终允许，第三方与 localhost 端点必须在此登记，为空时自定义 baseUrl 会被 403 拒绝 |
| `ZHIXU_COOKIE_SECURE` | 会话 Cookie 的 Secure 属性。生产必须为 true，否则进程启动失败 |
| `ZHIXU_DATA_DIR` | SQLite 数据目录。容器内固定 `/data` |
| `ZHIXU_QUOTA_CHAT` / `ZHIXU_QUOTA_DIAGNOSTIC` / `ZHIXU_QUOTA_REVIEW` | 每用户每日（UTC）调用额度，默认 40/10/30 |
| `ZHIXU_MAX_CONCURRENT_AI` | 每用户同时进行中的 AI 请求上限，默认 2 |
| `ZHIXU_AUDIT_RETENTION_DAYS` / `ZHIXU_USAGE_RETENTION_DAYS` | 审计与日用量保留天数，默认 90；0 会禁止生产预检通过 |
| `ZHIXU_ALLOW_INSECURE_LOCAL` | 仅本机回环测试可设为 true；生产预检会拒绝 |
| `ZHIXU_WEB_FETCH` / `ZHIXU_WEB_SEARCH` | 是否启用指定网页抓取、自动搜索。自动搜索默认关闭；开启后默认可用 You.com 免费供应商（无需 Key），未设置 `ZHIXU_SEARCH_ORDER` 时按内置顺序（You.com 在前）尝试 |
| `ZHIXU_SEARCH_ORDER` | 自动搜索供应商顺序，逗号分隔，可选 `you,tavily,brave,exa,firecrawl,deepseek,searxng`；默认 `you` 在链首，其余供应商只有配置 Key（searxng 为 `SEARXNG_URL`）后才会加入 |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | 服务端模型密钥，至少配一个。密钥不会出现在任何 API 响应或日志中 |

部署前运行预检：

```bash
npm run check:production
# 或容器内：docker compose exec zhixu npm run check:production
```

退出码 `1` 表示存在必须修复的问题（HTTP 地址、`COOKIE_SECURE=false`、`AUTH_REQUIRED=false`、`ZHIXU_TRUST_PROXY` 未开启、数据目录不可写、无模型密钥来源）；`0` 表示通过，提醒项仍会逐条打印，需要人工确认。脚本输出中文诊断。

## 3. 首次部署

### 3.1 准备配置

1. 准备服务器：Linux，Docker Engine + Compose v2 插件；域名 A/AAAA 记录指向服务器；防火墙放行 80/443。
2. 复制 `.env.example` 为 `.env`，至少填写：
   - `ZHIXU_PUBLIC_ORIGIN=https://<域名>`
   - `ZHIXU_TLS_DOMAIN=<域名>`
   - `ZHIXU_ACME_EMAIL=<运维邮箱>`
   - `ZHIXU_IMAGE=zhixu-study:1.0.0`（明确版本，不要 latest）
   - 模型密钥与按需覆盖的额度。
3. 替换域名。`deploy/nginx.conf` 中所有 `study.example.com`（两处 `server_name`、HTTP 跳转及注释示例）都必须替换为实际域名：
   ```bash
   grep -n 'study.example.com' deploy/nginx.conf
   # 编辑后确认没有残留：
   ! grep -n 'study.example.com' deploy/nginx.conf
   ```
4. 校验 compose 插值：`docker compose config --quiet`。compose 使用 `${ZHIXU_IMAGE:?…}`，未设置 `ZHIXU_IMAGE` 会直接报错，这是为了避免误用 `latest`；`.env` 必须包含明确 tag。

### 3.2 构建镜像并记录 digest

```bash
cd /opt/zhixu
docker compose build zhixu
bash deploy/record-release.sh zhixu-study:1.0.0
# 输出 deploy/releases/<UTC 时间>.json，包含 imageId 与 repoDigests。
# 只 build 未 push 时 repoDigests 可能为 []，imageId（sha256:...）仍可审计。
docker image inspect zhixu-study:1.0.0 --format '{{.Id}} {{json .RepoDigests}}'
```

把 `deploy/releases/*.json` 同步到发布记录（工单/对象存储）后再上线。以后升级、回滚都以这些不可变引用为准。

### 3.3 首次签发 TLS（干净主机，无任何已有证书）

首次签发使用 **certbot standalone**，需要独占宿主机 80 端口，因此**只启动应用容器，不启动 nginx**。脚本会在证书生成后才执行 `docker compose up -d` 启动 nginx。

```bash
bash deploy/tls-bootstrap.sh
```

脚本等价动作（可人工逐步执行，`$DOMAIN` / `$ACME_EMAIL` 来自 `.env`）：

```bash
export DOMAIN=study.example.com
export ACME_EMAIL=ops@example.com

# 1) 停掉可能残留的 nginx；standalone 需要独占 80。
docker compose stop nginx || true

# 2) 只启动应用，不启动 nginx。
docker compose up -d zhixu

# 3) standalone 首次签发；--cert-name 固定为 zhixu。
docker compose --profile tls run --rm --service-ports certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email "$ACME_EMAIL" \
  --cert-name zhixu \
  -d "$DOMAIN"

# 4) 必须确认证书真的生成，再启动 nginx。
test -s deploy/certs/live/zhixu/fullchain.pem
test -s deploy/certs/live/zhixu/privkey.pem
docker compose up -d
```

要点：

- **不依赖任何已存在目录或密钥**。脚本会创建 `deploy/certs/` 与 `deploy/certbot/`；certbot 首次运行时自行生成账户密钥、证书和 `live/zhixu` 软链接。
- 不要把 `certbot` 作为常驻服务 `up`：它带 `profiles: ["tls"]`，只在 `run` 时启动；否则会与 nginx 抢 80 端口。
- 宿主机 80 端口必须真正空闲（不要同时运行宿主机 nginx/apache）；否则 standalone 验证失败。DNS 必须已指向本机，且防火墙放行 80/443。
- 证书文件名和挂载必须与 nginx 一致（改路径前先读第 4 节）：

  | 宿主机 | certbot 容器 | nginx 容器 | nginx.conf 引用 |
  | --- | --- | --- | --- |
  | `deploy/certs/live/zhixu/fullchain.pem` | `/etc/letsencrypt/live/zhixu/fullchain.pem` | 同 certbot（只读挂载） | `ssl_certificate` |
  | `deploy/certs/live/zhixu/privkey.pem` | `/etc/letsencrypt/live/zhixu/privkey.pem` | 同 certbot（只读挂载） | `ssl_certificate_key` |
  | `deploy/certbot/.well-known/acme-challenge/` | `/var/www/certbot` | `/var/www/certbot`（只读） | HTTP-01 location 的 root |

- 域名变更时证书名仍是 `zhixu`，只需同步改 `server_name`、`ZHIXU_PUBLIC_ORIGIN`、`ZHIXU_TLS_DOMAIN`，然后重新签发到同一 `live/zhixu`。

### 3.4 启动后验证 HTTPS

```bash
export DOMAIN=study.example.com

# 应用存活与数据库就绪
curl -fsS "https://$DOMAIN/api/health"
curl -fsS "https://$DOMAIN/api/ready"

# HTTP 必须 301 到 HTTPS
curl -sSI "http://$DOMAIN/" | grep -Ei '^(HTTP/|Location:)'

# 证书链、域名和到期时间
openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName

# HSTS 存在
curl -sSI "https://$DOMAIN/" | grep -i '^strict-transport-security:'
```

浏览器再走一遍：首页 → 注册 → 登录 → 发起一次 AI 对话；确认地址栏证书有效、HTTP 自动跳转 HTTPS。

### 3.5 文件权限

```bash
chmod 600 .env
chmod 700 deploy/certs deploy/certbot
# certbot 已把私钥设为 600；不要为了“方便查看”放宽 deploy/certs 权限。
# 备份脚本会把输出目录收紧为 700、db/key/manifest 收紧为 600；手工搬动备份时保持同样权限。
```

非 Docker 部署：`npm ci && npm run build && npm run check:production && npm start`，由 systemd 拉起；前置 nginx 使用 `deploy/nginx.conf`，证书路径仍为 `/etc/letsencrypt/live/zhixu/`（宿主机 certbot 默认目录）。

## 4. HTTPS、安全头与证书续期

### 4.1 nginx 配置

- nginx 终结 TLS，TLS 1.2/1.3，启用 HSTS（`max-age=31536000; includeSubDomains`）。**HSTS 一旦下发很难回退**，确认长期提供 HTTPS 后再上线。
- 证书由 certbot 管理，compose 将 `./deploy/certs` 以只读方式挂到 `/etc/letsencrypt`。nginx 配置固定引用 `live/zhixu/fullchain.pem` 与 `privkey.pem`，与第 3.3 节表格一致。
- nginx 已配置 `X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`、`client_max_body_size 32m`、`server_tokens off`。由于 nginx 的 `add_header` 不跨声明层级继承，安全头抽到 `deploy/security-headers.conf`，并在 `/api/`、`/assets/`、`/` 与维护页分别 include。
- **部署前把 `deploy/nginx.conf` 中的 `study.example.com` 全部替换为实际域名**，与 `ZHIXU_PUBLIC_ORIGIN`、`ZHIXU_TLS_DOMAIN`、证书域名一致。
- 静态 gzip：nginx 对 `application/javascript`、`text/css`、`application/json`、`text/plain`、`image/svg+xml` 等启用 gzip；`gzip_proxied any` 使 Node 返回的静态响应也会压缩。
- 502 维护页：应用容器重启或不可达时，nginx 对 502/503/504 返回 `deploy/50x.html`（`internal`，禁止直接当静态资源访问）。API 调用方在维护窗口会收到 HTML 维护页而不是 JSON，这是预期。
- API 响应禁止缓存；`/assets/` 指纹文件长缓存；HTML `no-cache`。
- nginx 访问日志输出到容器 stdout，默认只记 URL 与状态码，**不记录请求体**。不要开启 `log_format` 的 `$request_body`。
- 应用进程本身配置了可信 Host/Origin 校验与 JSON-only 写请求；nginx 必须原样透传 `Host` 与 `Origin`（`deploy/nginx.conf` 已设置）。

### 4.2 续期（webroot + nginx reload）

首次签发用 standalone；之后统一用 **webroot** 续期，由运行中的 nginx 提供 `/.well-known/acme-challenge/`，不再占用 80 端口重启服务。仓库脚本已封装“检查 → 续期 → 校验配置 → reload”，未到期时不会每天 reload：

```bash
bash deploy/tls-renew.sh
```

手工等价命令：

```bash
export DOMAIN=study.example.com
docker compose exec -T nginx nginx -t
docker compose --profile tls run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  --non-interactive \
  --keep-until-expiring \
  --cert-name zhixu \
  -d "$DOMAIN" \
  --deploy-hook "touch /var/www/certbot/.renewed"
# 只有证书真的续期（deploy-hook 执行）后，才 reload：
test -f deploy/certbot/.renewed && docker compose exec -T nginx nginx -s reload
rm -f deploy/certbot/.renewed
```

宿主机 cron 示例（每天 03:17，日志自行轮转）：

```cron
17 3 * * * cd /opt/zhixu && /usr/bin/env bash deploy/tls-renew.sh >> /var/log/zhixu-tls.log 2>&1
```

systemd timer 示例：

```ini
# /etc/systemd/system/zhixu-tls-renew.service
[Unit]
Description=Renew zhixu TLS certificate
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/zhixu
ExecStart=/usr/bin/env bash deploy/tls-renew.sh
```

```ini
# /etc/systemd/system/zhixu-tls-renew.timer
[Unit]
Description=Daily zhixu TLS renewal check

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now zhixu-tls-renew.timer
systemctl list-timers zhixu-tls-renew.timer
```

检查续期是否生效：

```bash
openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" </dev/null 2>/dev/null \
  | openssl x509 -noout -dates
docker compose logs --tail=100 zhixu-certbot 2>/dev/null || true
```

> 证书过期后浏览器会直接阻断，且 HSTS 会让用户无法“忽略警告”继续访问。务必在到期前 30 天确认 `tls-renew.timer` 或 cron 已执行过至少一次。

## 5. 备份与恢复（数据库 + credentials.key + manifest）

### 5.1 备份

```bash
npm run backup:db
# 容器：docker compose exec zhixu npm run backup:db
```

- 使用 SQLite `VACUUM INTO` 生成一致性快照，先写临时文件再原子重命名，不会产出半写文件；运行中服务可安全执行。
- 每次备份生成**一组三个文件**到 `${ZHIXU_DATA_DIR}/backups/`（脚本会把输出目录权限收紧为 0700，包括 `--out` 指定的已有目录）：
  - `zhixu-<stamp>.db`：数据库快照，已做 `PRAGMA integrity_check`，权限 0600；
  - `zhixu-<stamp>.credentials.key`：BYOK 加密密钥副本（存在时），权限 0600；
  - `zhixu-<stamp>.manifest.json`：记录数据库与密钥的 SHA-256、字节数、凭据行数和配套关系，权限 0600。
- 默认保留最近 14 份（`--retention` 可调）；清理按 stamp 成组删除 db/key/manifest，不会留下孤立密钥或缺密钥的“半份备份”。
- 目标文件已存在时拒绝覆盖，防止误毁旧备份。
- **必须把整组文件（db + key + manifest）同步到另一台机器或对象存储**（rsync/rclone 均可）。只在本机保存的备份在磁盘故障时无意义。同步后定期在另一台机器做一次恢复演练。
- 若数据库已有加密凭据但 `credentials.key` 缺失/损坏，备份脚本会拒绝生成备份；先恢复正确密钥，再做新备份。
- 建议宿主机每日定时备份并单独同步：
  ```cron
  27 2 * * * cd /opt/zhixu && docker compose exec -T zhixu npm run backup:db >> /var/log/zhixu-backup.log 2>&1
  ```

### 5.2 恢复（人工执行，防止误覆盖）

恢复操作**不提供一键覆盖脚本**，必须人工执行。下面以 `STAMP=zhixu-2026-10-27_12-00-00` 为例；备份文件在容器内 `/data/backups/`。

1. 停止应用，保留 nginx（用户会看到 502 维护页）：
   ```bash
   docker compose stop zhixu
   ```
2. 校验 manifest 中的 SHA-256。任何一项不匹配都不要恢复：
   ```bash
   export STAMP=zhixu-2026-10-27_12-00-00
   docker compose run --rm --entrypoint node zhixu -e '
     const fs = require("node:fs");
     const path = require("node:path");
     const crypto = require("node:crypto");
     const dir = "/data/backups";
     const manifest = JSON.parse(fs.readFileSync(path.join(dir, process.argv[1]), "utf8"));
     for (const item of [manifest.database, manifest.credentialKey].filter(Boolean)) {
       const actual = crypto.createHash("sha256")
         .update(fs.readFileSync(path.join(dir, item.file))).digest("hex");
       if (actual !== item.sha256) throw new Error("SHA-256 不匹配：" + item.file);
       console.log("OK", item.file);
     }
   ' "$STAMP.manifest.json"
   ```
3. 把生产库移走并同时移除旧 WAL/SHM，复制备份库和密钥。维护 shell 需要 `--user root` 才能调整属主；数据库和密钥最终必须归 `node`：
   ```bash
   docker compose run --rm --user root -e STAMP="$STAMP" --entrypoint sh zhixu -c '
     set -eu
     cd /data
     if [ -f zhixu.db ]; then mv zhixu.db "zhixu.db.corrupted-$(date +%s)"; fi
     rm -f zhixu.db-wal zhixu.db-shm
     cp "backups/${STAMP}.db" zhixu.db
     chmod 600 zhixu.db
     if [ -f "backups/${STAMP}.credentials.key" ]; then
       cp "backups/${STAMP}.credentials.key" credentials.key
       chmod 600 credentials.key
     fi
     chown node:node zhixu.db
     [ ! -f credentials.key ] || chown node:node credentials.key
   '
   ```
   - 如果 manifest 的 `credentialKey` 为 `null` 且 `credentialRows` 为 0，本次备份不含个人凭据，不需要恢复密钥。
   - 如果 `credentialKey` 非 null，**必须**把对应 key 放回 `/data/credentials.key`。缺少它，个人模型/搜索 Key 永远无法解密，且开启 BYOK 的用户请求会失败。
4. 启动并校验：
   ```bash
   docker compose start zhixu
   docker compose exec zhixu node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/zhixu.db'); console.log(db.prepare('PRAGMA integrity_check').get()); db.close()"
   curl -fsS "https://<域名>/api/ready"
   ```
5. 登录一个开启过 BYOK 的账号，确认个人设置可读取；若失败，优先检查 `credentials.key` 是否来自同一份备份。
6. 告知用户恢复点时间；恢复点之后的注册、学习数据与额度记录会丢失。

### 5.3 VACUUM / 磁盘回收

`VACUUM INTO` 备份已经生成紧凑快照，但生产库本身在大量删除后不会自动缩小。确认磁盘占用偏高时，先备份，再停应用执行 `VACUUM`（运行中直接 VACUUM 可能因锁失败）：

```bash
docker compose exec -T zhixu npm run backup:db
docker compose stop zhixu
docker compose run --rm --user root --entrypoint node zhixu -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/zhixu.db");
  console.log(db.prepare("PRAGMA integrity_check").get());
  db.exec("VACUUM");
  db.close();
'
docker compose start zhixu
```

账户删除后，旧页可能仍留在历史备份中；按备份保留策略自然过期，必要时手动删除对应 stamp 的 db/key/manifest 三件套。

## 6. 日志与监控

- **日志有界**：compose 对 `zhixu`、`nginx`、`certbot` 均配置 `json-file` 驱动，`max-size=10m`、`max-file=5`。单服务最多保留约 50 MiB，不会无限写满磁盘。修改后需重建容器生效。
- **应用日志**（stdout，Docker 收集）：生产模式输出 `[audit]` 前缀 JSON，字段 `ts`、`requestId`、`event`、`result`、可选 `userId` 与脱敏 `detail`。事件名为 `auth.register`、`auth.login`、`auth.logout`、`auth.logout_all`、`auth.recover`、`auth.recovery_code`、`account.delete`、`workspace.save`、`workspace.note_delete`、`workspace.rate_limit`、`workspace.concurrency`、`quota.denied`、`ai.byok`、`ai.concurrency`、`credentials.save`、`credentials.delete`、`web.fetch`、`library.rate_limit`、`library.concurrency`、`library.meta`、`library.original`、`library.download`、`library.delete`（即 `library.*` 系列）。审计同时落 SQLite（`audit_log` 表），保留期由 `ZHIXU_AUDIT_RETENTION_DAYS` 控制；登录限速落 `auth_rate_limit`。日志不含邮箱、IP、密码、恢复码、对话正文或密钥。
- **nginx 日志**：访问日志输出到容器 stdout，包含 URL/状态/UA 与客户端 IP；错误日志由容器日志收集。
- 常用排查：
  ```bash
  docker compose ps
  docker compose logs --tail=200 zhixu
  docker compose logs --tail=100 nginx
  docker compose config --quiet
  ```
- 指标抓取或日志告警建议关注：
  - Docker HEALTHCHECK 探 `/api/ready`（数据库不可用即 unhealthy）；`/api/health` 仅表示进程存活。
  - 5xx 比例、502 维护页命中、模型调用失败率、429 额度命中数、登录失败次数（持续攀升可能是撞库）。
  - `/data` 所在磁盘用量：SQLite、WAL 与备份都会增长。
  - 证书到期时间（第 4.2 节）与 certbot 日志。
- 建议接入最小告警：实例不可达、磁盘 >85%、错误日志出现 `SQLITE_` 前缀、证书剩余有效期 < 15 天。

## 7. 配额与滥用

- 额度按用户、按 UTC 日期持久化在 SQLite：chat 默认 40、diagnostic 默认 10、review 默认 30。超限返回 `429` 与 `resetAt`（次日 UTC 0 点）。
- 指定网页来源核验使用独立的进程内小时限流，默认每用户/IP `ZHIXU_WEB_HOURLY_LIMIT=30`；它不是 AI 额度，不写入每日用量表。公网部署建议只允许需要的域名。
- 同一用户默认最多 2 个在途 AI 请求（`ZHIXU_MAX_CONCURRENT_AI`），超限返回 `429` + `Retry-After`；这是单进程闸门，与单节点约束一致。
- 扣减发生在模型调用前，上游失败不退还当日额度（可在数据库按运维决策人工返还）。
- 审计日志与每日用量默认保留 90 天，由启动时和每 24 小时任务清理；保留期可配置，生产预检拒绝 0 或非法值。过期超过 30 天的认证限流行也会清理。
- 调整额度：修改 `.env` 后 `docker compose up -d` 重建应用容器。
- 公网注册开放时，关注注册速率；如被刷，先临时关闭注册入口（nginx 层对 `/api/auth/register` 做 IP 限速或直接 403），再评估。

## 8. 依赖升级、发布与回滚

### 8.1 升级前

1. 在测试环境跑 `npm run check && npm test && npm run build`，或确认待发布 commit 的 CI 已通过（CI 命令与本地一致，见第 12 节）。
2. 生产先备份（第 5 节），确认 db/key/manifest 三件套已同步到第二存储位置。
3. 记录当前版本和 digest，便于回滚：
   ```bash
   bash deploy/record-release.sh zhixu-study:1.0.0
   cp .env .env.before-1.0.1
   ```

### 8.2 发布新版本

```bash
# 1) 构建新 tag（不要用 latest）
ZHIXU_IMAGE=zhixu-study:1.0.1 docker compose build zhixu

# 2) 记录不可变 imageId / repoDigests
bash deploy/record-release.sh zhixu-study:1.0.1

# 3) 更新 .env 的 ZHIXU_IMAGE=zhixu-study:1.0.1，然后只重建应用容器
docker compose up -d --no-build zhixu

# 4) 应用容器重建后 IP 可能变化，reload nginx 让 upstream 重新解析 zhixu
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload

# 5) 验证
docker compose ps
curl -fsS "https://<域名>/api/health"
curl -fsS "https://<域名>/api/ready"
docker compose logs --since 10m zhixu
```

应用启动迁移是幂等的；观察 30 分钟错误率与 5xx。不要重启 nginx 容器，reload 即可平滑切换 worker。

> 直接写 `ZHIXU_IMAGE=zhixu-study:1.0.1 docker compose up -d --no-build zhixu` 只对本次命令生效；下次 `docker compose up` 会按 `.env` 重新选择镜像，可能回退。要让发布状态持久，必须把 tag 写回 `.env`。

### 8.3 回滚

应用代码回滚（上一版 tag 必须在本机或可从 registry 拉取）：

```bash
# 从 1.0.1 回滚到明确的 1.0.0
ZHIXU_IMAGE=zhixu-study:1.0.0 docker compose up -d --no-build zhixu

# 或使用 registry digest 锁定不可变版本
ZHIXU_IMAGE=registry.example.com/team/zhixu-study@sha256:<digest> \
  docker compose up -d --no-build zhixu

# 应用容器重建后同样 reload nginx，避免它继续使用旧容器 IP：
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
```

数据库回滚：

- 新版本可能已执行向前迁移，旧镜像不保证能读新 schema。若回滚后应用因迁移/表结构失败，必须恢复**升级前**的备份（第 5.2 节），同时恢复配套 `credentials.key`。
- 不要只回滚镜像而保留已被新版本改写的数据库，除非发布说明明确该迁移向后兼容。

回滚后重新验证 `/api/health`、`/api/ready`、登录与 BYOK 凭据读取，并记录事件时间线。

## 9. 密钥轮换

- **模型密钥**：更新 `.env` 中 `GEMINI_API_KEY` 或 `OPENAI_API_KEY` → `docker compose up -d` 重启应用容器。旧密钥在供应商侧吊销。
- **会话与恢复码**：存储在数据库中的只有哈希；换供应商密钥不影响会话。如怀疑数据库泄露，让所有用户登出（运维可清空 `sessions` 表后重启，等价全员强制下线；恢复码同样需要用户重新生成）。
- **TLS 证书**：按第 4.2 节用 webroot 续期；脚本只在证书实际续期后 `nginx -s reload`，不要手工删除 `deploy/certs` 后直接重启 nginx。
- **BYOK 加密密钥**：`credentials.key` 轮换会使已保存的个人凭据无法解密。当前版本不提供自动轮换，且服务端在已有密文无法用当前 key 解密时会拒绝保存新配置，因此顺序必须是**先清除所有 `user_credentials` 旧行，再替换 key**；只替换 key 会留下无法解密的旧行并让健康检查失败。该操作会让所有用户已保存的个人 Key 失效，必须提前通知。建议流程：
  1. 先按第 5 节生成并异地保存一份完整备份；旧备份仍可用旧 key 解密，不要覆盖。
  2. 停止应用：`docker compose stop zhixu`。
  3. 删除**所有**旧凭据行（不能只删部分行，否则剩余的旧样本仍会判定 key 不匹配）：
     ```bash
     docker compose run --rm --entrypoint node zhixu -e '
       const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync("/data/zhixu.db");
       db.exec("BEGIN IMMEDIATE; DELETE FROM user_credentials; COMMIT;");
       console.log(db.prepare("SELECT COUNT(*) AS count FROM user_credentials").get());
       db.close();
     '
     ```
     应输出 `{ count: 0 }`。
  4. 替换密钥文件：写入新的 32 字节随机 key 后原子替换；属主保持 `node`，权限 0600：
     ```bash
     docker compose run --rm --user root --entrypoint sh zhixu -c '
       set -eu
       umask 077
       head -c 32 /dev/urandom > /data/credentials.key.new
       chown node:node /data/credentials.key.new
       chmod 600 /data/credentials.key.new
       mv -f /data/credentials.key.new /data/credentials.key
     '
     ```
     也可以删除旧 key，让首次保存个人配置时重新生成；旧 key 不要留在数据目录，如需留档只放在离线备份中。
  5. 启动应用并检查 `/api/ready`：没有旧凭据时，新 key（或删除 key 后的未初始化状态）应为健康；首次保存个人配置会使用新 key。
  6. 通知所有开启 BYOK 的用户重新登录并重新保存所需个人配置：模型 Key 必填；搜索 Key 仅在联网搜索时需要（You.com 可留空）。旧密文已被删除，无法恢复。
  7. 轮换后重新执行 `npm run backup:db`，确认新备份的 key 与当前 `credentials.key` 一致；若选择删除旧 key 且尚未生成新 key，manifest 的 `credentialKey` 应为 `null`。用户重新保存前 `credentialRows` 应为 0。不要单独把旧备份中的 `user_credentials` 行恢复进轮换后的数据库，它们只能用旧 key 解密。
- `.env` 含全部机密：不要提交、不要打进镜像、不要在工单或聊天工具中粘贴明文。镜像构建已通过 `.dockerignore` 排除 `.env*`。

## 10. 数据删除与账户

- 用户可自行 `DELETE /api/account`（需密码验证）：级联删除该用户的学习数据、会话、恢复码、额度记录与账号级云端书架（书目元数据和原文件 BLOB）。
- 云端书架每账号最多 100 本、原文件总量 500 MiB，单本最大 30 MiB；SQLite 数据库和 `npm run backup:db` 备份会随书籍增长，容量规划必须把书籍 BLOB 计入。
- 用户申请彻底删除时：
  1. 确认其已自行删除账户，或由用户在界面操作。
  2. 运维按第 5.3 节执行 `VACUUM`（或跑一次 `npm run backup:db`）让旧页释放；此前的备份文件中仍含其数据，按备份保留策略自然过期，必要时手动删除对应备份。
  3. nginx 访问日志中仅存 URL/状态码，不含正文，无需单独清理；如需可轮转清理。
- 数据库文件、`credentials.key` 与备份属于敏感数据：传输用加密通道，存储目录权限最小化。

## 11. 事故响应

| 现象 | 首步 | 后续 |
| --- | --- | --- |
| 服务不可达 | `docker compose ps`、`curl /api/health` | 看应用日志启动错误；磁盘满/端口占用/迁移失败是常见原因 |
| 502 维护页 | `docker compose ps zhixu`、`docker compose logs --tail=200 zhixu` | 应用崩溃或重启中；修复后 nginx 自动恢复代理，无需 reload |
| 数据库损坏 | 立即 `docker compose stop zhixu` | 保留 `.corrupted-*` 现场，按第 5.2 节从最近备份恢复（含 credentials.key） |
| 证书过期/告警 | `openssl s_client ... -dates`、`docker compose logs zhixu-certbot` | 检查 80 端口、webroot 挂载、`server_name` 与 cron/timer；必要时手工执行第 4.2 节 |
| 大量 401/403 | 查看登录失败与审计日志 | 疑似撞库：nginx 对 `/api/auth/*` 加 IP 限速，必要时临时关闭注册 |
| 模型供应商故障 | 确认 `GEMINI_*/OPENAI_*` 状态 | 用户侧表现为明确错误，无伪回答兜底；无需运维介入 |
| 疑似数据泄露 | 停止服务、保全日志 | 吊销模型密钥、清空会话表强制下线、通知用户改密码与重置恢复码，评估是否需要法律报告义务 |

事故后：记录时间线、影响面（哪些用户、哪段时间）、修复动作；把根因与改进写回本手册。

## 12. CI 与本地验证边界

### 12.1 GitHub Actions 做什么

`.github/workflows/ci.yml` 在 push 到 `main` / `master`、pull request 与手动触发时运行一个 Linux job（Node.js 22.x，`permissions: contents: read`，30 分钟超时）：

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 安装 | `npm ci --no-audit --no-fund --registry=https://registry.npmjs.org --replace-registry-host=always` | 严格按 `package-lock.json`；lockfile 的 `resolved` 使用区域镜像，CI 改用官方 registry 拉取同版本 tarball |
| 类型检查 | `npm run check` | `tsc -b` |
| 回归 | `npm test` | 50 个测试文件；使用 `os.tmpdir()` 与回环端口，不访问外部网络 |
| 构建 | `npm run build` | `tsc -b && vite build` |

- CI **不配置任何模型/搜索密钥**，也不读取 `.env`。测试中的 key 都是假值；`server/index.ts` 只在真实入口动态加载 dotenv，测试导入 `createApp` 不会读取仓库 `.env`。
- 应用要求 Node.js >=22.13；**测试运行需要 22.15+**（`tests/markdown.test.ts` 使用 `module.registerHooks`）。CI 使用 `node-version: '22.x'`（当前 22 LTS 线），不会落到 22.13/22.14。
- `npm run test:production` 只是 `tests/production-config.test.ts` + `tests/server-http.test.ts` 的定向复跑，已包含在 `npm test` 内；需要局部排查时手动执行，不需要单独 CI job。

### 12.2 CI 明确不做什么

- 不执行 `npm start` / `npm start -- --production`：生产启动要求 `ZHIXU_PUBLIC_ORIGIN`、Cookie 等真实配置，代理信任等生产项由 `npm run check:production` 检查，CI 不应伪造部署环境。
- 不执行 `npm run check:production`：它面向目标主机的真实 `.env`；其判定逻辑由 `tests/production-config.test.ts` 用临时 env 覆盖，不能替代目标主机上的实际预检。
- 不执行 `docker compose build/up`、`deploy/tls-*.sh`、certbot 或 nginx；`tests/deployment-config.test.ts` 只做文件静态一致性回归。
- 不运行 `npm run eval:teaching` / `npm run eval:teaching:broad`：需要真实供应商密钥与网络，退出码 2/3（未配置/供应商失败）都不能视为通过；真实模型评测结果必须单独记录，不能用 CI 绿灯替代。
- 不发布镜像、不部署、不连接生产数据库，也不接触真实用户数据。

### 12.3 本地与目标主机的必做验证

1. 提交前在本地（Node.js 22.15+）运行与 CI 相同的命令：`npm ci && npm run check && npm test && npm run build`。
2. 需要真实模型评测时，在持有密钥的维护机上另跑 `npm run eval:teaching -- --list` 与 `npm run eval:teaching`，并把结果与固定剧本的局限一起记录。
3. 目标主机上线前必须执行 `npm run check:production`（退出码 0）并按第 13 节逐项验证 Docker、nginx、TLS、备份恢复与真实页面；CI 与开发机从未验证这些运行时项。

## 13. 上线验收清单

- [ ] 待部署 commit 的 CI（`npm run check` / `npm test` / `npm run build`）通过；镜像由同一 commit 构建。
- [ ] CI 未配置真实模型/搜索密钥；真实模型评测（`npm run eval:teaching`）结果单独记录，不用 CI 绿灯代替。
- [ ] `npm run check:production` 退出码 0；所有提醒项已人工确认。
- [ ] `ZHIXU_AUTH_REQUIRED` 为 true；`ZHIXU_COOKIE_SECURE` 为 true；`ZHIXU_TRUST_PROXY` 为 true。
- [ ] `ZHIXU_PUBLIC_ORIGIN`、`ZHIXU_TLS_DOMAIN`、`deploy/nginx.conf` 的 `server_name`、证书域名四者一致；`study.example.com` 无残留。
- [ ] `ZHIXU_IMAGE` 是明确版本（不是 latest）；`deploy/releases/*.json` 已记录 imageId/repoDigests。
- [ ] 干净主机按第 3.3 节先 certbot standalone、后 nginx；首次执行前 `deploy/certs` 不存在也能成功。
- [ ] 证书文件路径与第 3.3 节表格一致；`deploy/certs/live/zhixu/{fullchain,privkey}.pem` 存在。
- [ ] HTTPS 证书有效；HTTP 301 到 HTTPS；HSTS 头存在；`openssl x509 -dates` 到期时间符合预期。
- [ ] `bash deploy/tls-renew.sh` 能在未到期时安全返回；cron/systemd timer 已启用并跑过一次。
- [ ] `/api/health` 与 `/api/ready` 均通过；Docker HEALTHCHECK 状态 healthy。
- [ ] 应用容器不可用时浏览器看到 `deploy/50x.html` 维护页；恢复后自动消失。
- [ ] 大于 1 KiB 的 JS/CSS/JSON 响应返回 `Content-Encoding: gzip`（用静态 asset 和 `curl -H 'Accept-Encoding: gzip' -sI ...` 抽查）。
- [ ] 日志驱动为 json-file 且 `max-size=10m`、`max-file=5`；`docker inspect` 可确认。
- [ ] 注册 → 登录 → 学习 → 登出 → 再登录，学习数据（工作区 revision）一致。
- [ ] 未登录访问聊天/诊断/复习接口被 401 拒绝。
- [ ] 额度超限返回 429 与 `resetAt`。
- [ ] `npm run backup:db` 成功生成 db + credentials.key + manifest，且 `integrity_check` 通过；db/key/manifest 权限为 0600、备份目录为 0700；三件套已同步到第二存储位置。
- [ ] 一次完整恢复演练成功（在测试环境执行，包含 credentials.key 与 manifest 校验）。
- [ ] 一次从 1.0.1 回滚到 1.0.0 的演练成功；回滚命令使用明确 tag 或 digest。
- [ ] `.env`、`deploy/certs/` 未出现在版本库；日志抽查无密码/密钥/对话正文。
- [ ] 静态配置回归通过：`npx tsx --test tests/deployment-config.test.ts`（不需要 Docker）。
- [ ] 文档与服务行为一致：单节点表述未被改成「可横向扩展」；未声称开发机或 CI 验证过 Docker 运行。
