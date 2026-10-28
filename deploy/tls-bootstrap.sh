#!/usr/bin/env bash
# 干净主机首次签发 TLS 证书。
#
# 前提：.env 已配置 ZHIXU_PUBLIC_ORIGIN、ZHIXU_TLS_DOMAIN、ZHIXU_ACME_EMAIL；
#       deploy/nginx.conf 的 study.example.com 已替换为同一个域名。
# 用法：bash deploy/tls-bootstrap.sh [域名] [ACME 邮箱]
#
# 流程刻意分成两步：
#   1. 只启动 zhixu 应用容器（不启动 nginx），certbot standalone 独占 80 完成 HTTP-01；
#   2. 确认 live/zhixu/fullchain.pem 与 privkey.pem 存在后，再 docker compose up -d 启动 nginx。
# 因此首次执行不依赖任何已有证书目录或密钥。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=deploy/tls-lib.sh
. "$SCRIPT_DIR/tls-lib.sh"

zhixu_require_compose

DOMAIN="$(zhixu_resolve_domain "${1:-}")"
EMAIL="${2:-${ZHIXU_ACME_EMAIL:-}}"
[ -n "$EMAIL" ] || EMAIL="$(zhixu_env_value ZHIXU_ACME_EMAIL)"
[ -n "$EMAIL" ] || zhixu_die "缺少 ACME 邮箱：请设置 .env 的 ZHIXU_ACME_EMAIL，或作为第二个参数传入。"
case "$EMAIL" in
  *@*.*) ;;
  *) zhixu_die "ACME 邮箱格式不正确：$EMAIL" ;;
esac
zhixu_assert_nginx_domain "$DOMAIN"

COMPOSE=(docker compose)
mkdir -p "$ZHIXU_CERT_ROOT" "$ZHIXU_WEBROOT"

if [ -s "$ZHIXU_LIVE_DIR/fullchain.pem" ] && [ -s "$ZHIXU_LIVE_DIR/privkey.pem" ]; then
  echo "==> 已存在证书：$ZHIXU_LIVE_DIR"
  "${COMPOSE[@]}" up -d
  echo "证书未改动。如需强制重签，请先备份 deploy/certs，再按文档删除对应 live/archive 后重跑本脚本。"
  exit 0
fi

echo "==> 首次签发需要独占宿主机 80 端口，先停止可能存在的 nginx"
"${COMPOSE[@]}" stop nginx >/dev/null 2>&1 || true

echo "==> 只启动应用容器（此时不启动 nginx）"
"${COMPOSE[@]}" up -d zhixu

echo "==> certbot standalone 签发：$DOMAIN"
"${COMPOSE[@]}" --profile tls run --rm --service-ports certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --cert-name "$ZHIXU_CERT_NAME" \
  -d "$DOMAIN"

[ -s "$ZHIXU_LIVE_DIR/fullchain.pem" ] \
  || zhixu_die "签发流程结束但未找到 $ZHIXU_LIVE_DIR/fullchain.pem，请检查 certbot 输出和 deploy/certs。"
[ -s "$ZHIXU_LIVE_DIR/privkey.pem" ] \
  || zhixu_die "签发流程结束但未找到 $ZHIXU_LIVE_DIR/privkey.pem，请检查 certbot 输出和 deploy/certs。"

echo "==> 证书就绪，启动应用与 nginx"
"${COMPOSE[@]}" up -d

if command -v curl >/dev/null 2>&1; then
  echo "==> HTTPS 自检（DNS 尚未指向本机时失败属预期）"
  sleep 2
  if curl -fsS --max-time 20 "https://$DOMAIN/api/health"; then
    printf '\nHTTPS 验证通过。\n'
  else
    printf '\n警告：HTTPS 自检失败，请检查 DNS、80/443 端口与 docker compose logs nginx。\n' >&2
  fi
fi
