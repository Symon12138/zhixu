#!/usr/bin/env bash
# 由 deploy/tls-bootstrap.sh 与 deploy/tls-renew.sh source；不要直接执行。
#
# 证书名固定为 zhixu，域名变化不影响证书文件路径；
# 宿主机目录与 docker-compose.yml、deploy/nginx.conf 必须保持一致。

ZHIXU_CERT_NAME="zhixu"
ZHIXU_CERT_ROOT="deploy/certs"
ZHIXU_LIVE_DIR="$ZHIXU_CERT_ROOT/live/$ZHIXU_CERT_NAME"
ZHIXU_WEBROOT="deploy/certbot"

zhixu_die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

# 读取 .env 的单行值；仅处理域名/邮箱/镜像 tag 这类简单值。
zhixu_env_value() {
  local key="$1"
  local value
  [ -f .env ] || return 0
  value="$(sed -nE "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*(.*)$/\1/p" .env \
    | tail -n 1 \
    | tr -d '\r')"
  # 去掉成对的单/双引号。
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s\n' "$value"
}

zhixu_require_compose() {
  command -v docker >/dev/null 2>&1 || zhixu_die "未找到 docker，请先在部署主机安装 Docker Engine 与 Compose 插件。"
  docker compose version >/dev/null 2>&1 || zhixu_die "未找到 docker compose 插件，请安装 Compose v2。"
  docker info >/dev/null 2>&1 || zhixu_die "无法访问 Docker daemon；请确认当前用户有权限（或使用 sudo）。"
}

# 优先级：命令行参数 > .env 的 ZHIXU_TLS_DOMAIN > ZHIXU_PUBLIC_ORIGIN 的主机名。
zhixu_resolve_domain() {
  local domain="${1:-${ZHIXU_TLS_DOMAIN:-}}"
  if [ -z "$domain" ]; then
    domain="$(zhixu_env_value ZHIXU_TLS_DOMAIN)"
  fi
  if [ -z "$domain" ]; then
    local origin
    origin="$(zhixu_env_value ZHIXU_PUBLIC_ORIGIN)"
    [ -n "$origin" ] || zhixu_die "未提供域名：请在 .env 设置 ZHIXU_TLS_DOMAIN 或 ZHIXU_PUBLIC_ORIGIN，或作为第一个参数传入。"
    domain="${origin#*://}"
    domain="${domain%%/*}"
    domain="${domain%%:*}"
  fi
  printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
    || zhixu_die "域名格式不正确：$domain（只写主机名，不要带协议、端口或路径）。"
  printf '%s' "$domain" | grep -q '\.' \
    || zhixu_die "域名格式不正确：$domain"
  printf '%s\n' "$domain"
}

# 防止证书签给 A 域名而 nginx 仍配置 B 域名，导致浏览器 SNI/证书不匹配。
zhixu_assert_nginx_domain() {
  local domain="$1"
  grep -Eq "^[[:space:]]*server_name[[:space:]]+([^;]*[[:space:]])?${domain}([[:space:]]|;)" \
    deploy/nginx.conf \
    || zhixu_die "deploy/nginx.conf 的 server_name 尚未替换为 $domain；请先替换所有 study.example.com 再签发证书。"
}
