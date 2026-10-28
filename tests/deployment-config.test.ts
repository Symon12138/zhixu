import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 部署静态回归：不启动 Docker，只读取仓库文件，防止 compose/nginx/TLS 脚本/文档
 * 在后续修改中失去一致性。真实 build/up/证书签发必须在部署主机执行。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fileCache = new Map<string, string>();
function fixture(relative: string): string {
  const cached = fileCache.get(relative);
  if (cached !== undefined) return cached;
  const content = fs.readFileSync(path.join(ROOT, relative), "utf8");
  fileCache.set(relative, content);
  return content;
}

function composeService(compose: string, name: string): string {
  const servicesStart = compose.indexOf("services:");
  const volumesStart = compose.indexOf("\nvolumes:");
  assert.ok(servicesStart >= 0, "docker-compose.yml 缺少 services:");
  assert.ok(volumesStart > servicesStart, "docker-compose.yml 缺少顶层 volumes:");
  const section = compose.slice(servicesStart, volumesStart);
  const pattern = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|$)`);
  const match = pattern.exec(section);
  assert.ok(match, `docker-compose.yml 缺少服务 ${name}`);
  return match[1];
}

test("compose：应用镜像使用显式 tag 变量，禁止 latest", () => {
  const compose = fixture("docker-compose.yml");
  assert.match(compose, /image:\s*\$\{ZHIXU_IMAGE:\?[^}]+\}/);
  assert.doesNotMatch(compose, /image:\s*\$\{ZHIXU_IMAGE:-/);
  assert.doesNotMatch(compose, /^\s*image:\s*\S*:latest\s*$/m);
  assert.match(compose, /build:\s*\n\s*context:\s*\.\s*\n\s*dockerfile:\s*Dockerfile/);
  assert.match(compose, /stop_grace_period:\s*25s/);
  assert.match(compose, /init:\s*true/);
});

test("compose：三个服务日志都有界，应用不发布公网端口", () => {
  const compose = fixture("docker-compose.yml");
  for (const name of ["zhixu", "nginx", "certbot"]) {
    const block = composeService(compose, name);
    assert.match(block, /logging:\s*\n\s*driver:\s*json-file/, `${name} 缺少 logging`);
    assert.match(block, /max-size:\s*"10m"/, `${name} 缺少 max-size`);
    assert.match(block, /max-file:\s*"5"/, `${name} 缺少 max-file`);
  }
  const app = composeService(compose, "zhixu");
  assert.doesNotMatch(app, /^\s{4}ports:/m, "应用容器不应发布端口，公网入口只走 nginx");
  assert.match(app, /expose:\s*\n\s*-\s*"3001"/);
});

test("compose 与 nginx：证书和 ACME webroot 路径一致", () => {
  const compose = fixture("docker-compose.yml");
  const nginx = composeService(compose, "nginx");
  const certbot = composeService(compose, "certbot");
  const nginxConf = fixture("deploy/nginx.conf");

  assert.match(certbot, /profiles:\s*\n\s*-\s*tls/);
  assert.match(certbot, /\.\/deploy\/certs:\/etc\/letsencrypt/);
  assert.match(certbot, /\.\/deploy\/certbot:\/var\/www\/certbot/);
  assert.match(nginx, /\.\/deploy\/certs:\/etc\/letsencrypt:ro/);
  assert.match(nginx, /\.\/deploy\/certbot:\/var\/www\/certbot:ro/);
  assert.match(nginx, /\.\/deploy\/50x\.html:\/usr\/share\/nginx\/html\/50x\.html:ro/);

  assert.match(
    nginxConf,
    /ssl_certificate\s+\/etc\/letsencrypt\/live\/zhixu\/fullchain\.pem;/,
  );
  assert.match(
    nginxConf,
    /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/zhixu\/privkey\.pem;/,
  );
  assert.match(nginxConf, /location \/\.well-known\/acme-challenge\/\s*\{[\s\S]*?root \/var\/www\/certbot;/);

  const certName = /ZHIXU_CERT_NAME="([^"]+)"/.exec(fixture("deploy/tls-lib.sh"));
  assert.equal(certName?.[1], "zhixu", "TLS 脚本的证书名必须与 nginx 固定路径一致");
  assert.match(fixture("deploy/tls-bootstrap.sh"), /--cert-name "\$ZHIXU_CERT_NAME"/);
});

test("nginx：静态 gzip、502 维护页、安全头与缓存策略", () => {
  const nginx = fixture("deploy/nginx.conf");
  assert.match(nginx, /gzip on;/);
  assert.match(nginx, /gzip_proxied any;/);
  for (const type of [
    "application/javascript",
    "text/css",
    "application/json",
    "text/plain",
    "image/svg+xml",
  ]) {
    assert.ok(nginx.includes(type), `gzip_types 缺少 ${type}`);
  }
  assert.match(nginx, /error_page 502 503 504 \/50x\.html;/);
  assert.match(nginx, /location = \/50x\.html \{[\s\S]*?internal;/);
  assert.ok(fs.existsSync(path.join(ROOT, "deploy/50x.html")));
  assert.match(fixture("deploy/50x.html"), /服务暂时维护中/);

  assert.match(nginx, /location \/api\/[\s\S]*?include \/etc\/nginx\/security-headers\.conf;/);
  assert.match(nginx, /location \/assets\/[\s\S]*?include \/etc\/nginx\/security-headers\.conf;/);
  assert.match(nginx, /location \/ \{[\s\S]*?include \/etc\/nginx\/security-headers\.conf;/);
  assert.match(nginx, /add_header Cache-Control "no-store" always;/);
  assert.match(nginx, /expires 30d;/);
  assert.match(nginx, /add_header Cache-Control "no-cache" always;/);
});

test("Dockerfile：node:24、非 root、healthcheck、直接 node 启动且不复制评测数据", () => {
  const dockerfile = fixture("Dockerfile");
  assert.match(dockerfile, /FROM node:24-alpine AS runtime/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*?\/api\/ready/);
  assert.match(
    dockerfile,
    /CMD \["node", "--import", "tsx", "server\/index\.ts", "--production"\]/,
  );
  assert.doesNotMatch(dockerfile, /CMD \["npm", "start"\]/);
  assert.doesNotMatch(dockerfile, /COPY (?:\.\/)?eval\b/);
  assert.doesNotMatch(dockerfile, /COPY (?:\.\/)?tests\b/);
  assert.doesNotMatch(dockerfile, /COPY (?:\.\/)?scripts \.\/scripts/);
  assert.doesNotMatch(dockerfile, /\.tmp-reviewer/);
  assert.match(dockerfile, /src\/types\.ts/);
  assert.match(dockerfile, /src\/bookTypes\.ts/);
  assert.match(dockerfile, /src\/lib\/learningState\.ts/);
  assert.match(dockerfile, /src\/lib\/bookProtocol\.ts/);
  assert.match(dockerfile, /src\/lib\/backup\.ts/);
  // backup.ts 运行时还会 import 这些模块，漏复制会让 npm run backup:db 在生产镜像内失败。
  assert.match(dockerfile, /src\/lib\/diagnostic\.ts/);
  assert.match(dockerfile, /src\/lib\/review\.ts/);
  assert.match(dockerfile, /src\/lib\/sessionMerge\.ts/);
  assert.match(dockerfile, /scripts\/backup-db\.ts/);
  assert.match(dockerfile, /scripts\/check-production-env\.ts/);
});

test(".dockerignore 排除环境密钥、数据、评测和 reviewer 临时文件", () => {
  const ignore = fixture(".dockerignore").split(/\r?\n/);
  for (const entry of [
    "node_modules",
    "dist",
    ".data",
    "tests",
    "eval",
    ".env",
    ".env.*",
    "scripts/.tmp-*",
    "*.db",
    "*.db-wal",
    "*.db-shm",
  ]) {
    assert.ok(ignore.includes(entry), `.dockerignore 缺少 ${entry}`);
  }
  assert.ok(ignore.includes("!.env.example"));
  const gitignore = fixture(".gitignore").split(/\r?\n/);
  assert.ok(gitignore.includes("deploy/certs/"), "证书目录必须保持 gitignore");
  assert.ok(gitignore.includes("deploy/certbot/"), "certbot webroot 必须保持 gitignore");
});

test("TLS bootstrap：首次签发先只启动应用，证书存在后再启动 nginx", () => {
  const script = fixture("deploy/tls-bootstrap.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /certbot certonly/);
  assert.match(script, /--standalone/);
  assert.match(script, /up -d zhixu/);
  assert.match(script, /mkdir -p "\$ZHIXU_CERT_ROOT" "\$ZHIXU_WEBROOT"/);
  assert.match(script, /\[ -s "\$ZHIXU_LIVE_DIR\/fullchain\.pem" \]/);
  assert.match(script, /\[ -s "\$ZHIXU_LIVE_DIR\/privkey\.pem" \]/);

  const issueIndex = script.indexOf("--service-ports certbot certonly");
  assert.ok(issueIndex > 0, "缺少 standalone 签发命令");
  const beforeIssue = script.slice(0, issueIndex);
  assert.match(beforeIssue, /up -d zhixu/);
  assert.doesNotMatch(beforeIssue, /up -d nginx/, "签发前不能启动 nginx");
  assert.match(beforeIssue, /stop nginx/, "签发前应停止可能残留的 nginx 以释放 80");

  const afterIssue = script.slice(issueIndex);
  assert.match(afterIssue, /up -d\s*$/m, "签发成功后应启动完整 compose");
});

test("TLS renew：webroot 续期、nginx 配置校验与 reload", () => {
  const script = fixture("deploy/tls-renew.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /--webroot/);
  assert.match(script, /--webroot-path \/var\/www\/certbot/);
  assert.match(script, /--keep-until-expiring/);
  assert.match(script, /nginx -t/);
  assert.match(script, /nginx -s reload/);
  assert.match(script, /\.renewed/);
  assert.match(script, /ps --status running --services/);
});

test("发布记录脚本记录 imageId 与 repoDigests", () => {
  const script = fixture("deploy/record-release.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /docker image inspect/);
  assert.match(script, /\{\{\.Id\}\}/);
  assert.match(script, /\{\{json \.RepoDigests\}\}/);
  assert.match(script, /deploy\/releases/);
});

test(".env.example：镜像版本与 TLS 变量齐全，未使用 latest", () => {
  const env = fixture(".env.example");
  assert.match(env, /^ZHIXU_IMAGE=zhixu-study:\d+\.\d+\.\d+$/m);
  assert.doesNotMatch(env, /^ZHIXU_IMAGE=.*latest/m);
  assert.match(env, /^ZHIXU_TLS_DOMAIN=study\.example\.com$/m);
  assert.match(env, /^ZHIXU_ACME_EMAIL=ops@example\.com$/m);
});

test("文档：干净主机签发、续期、备份恢复、升级回滚与验证状态一致", () => {
  const docs = fixture("docs/OPERATIONS.md");
  assert.match(docs, /未在本机实际执行 build \/ up \/ certbot/);
  assert.match(docs, /certbot standalone/);
  assert.match(docs, /docker compose up -d zhixu/);
  assert.match(docs, /--service-ports certbot certonly/);
  assert.match(docs, /docker compose stop nginx/);
  assert.match(docs, /deploy\/certs\/live\/zhixu\/fullchain\.pem/);
  assert.match(docs, /deploy\/certs\/live\/zhixu\/privkey\.pem/);

  assert.match(docs, /tls-renew\.sh/);
  assert.match(docs, /nginx -s reload/);
  assert.match(docs, /17 3 \* \* \*/);
  assert.match(docs, /\[Timer\]/);

  assert.match(docs, /credentials\.key/);
  assert.match(docs, /\.manifest\.json/);
  assert.match(docs, /SHA-256/);
  assert.match(docs, /VACUUM/);

  assert.match(docs, /ZHIXU_IMAGE=zhixu-study:1\.0\.0/);
  assert.match(docs, /ZHIXU_IMAGE=zhixu-study:1\.0\.1/);
  assert.match(docs, /回滚到明确的 1\.0\.0/);
  assert.match(docs, /repoDigests|RepoDigests/);
  assert.match(docs, /max-size=10m/);
  assert.match(docs, /max-file=5/);
  assert.match(docs, /50x\.html/);
  assert.match(docs, /tests\/deployment-config\.test\.ts/);
});
