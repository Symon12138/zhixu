#!/usr/bin/env bash
# 续期 TLS 证书：webroot 验证 + nginx reload。
#
# 由宿主机 cron 或 systemd timer 定期执行（建议每天一次，certbot 只在临近到期时真正续期）。
# 用法：bash deploy/tls-renew.sh [域名]
#
# 首次签发必须由 deploy/tls-bootstrap.sh 完成；nginx 必须在运行状态，
# 因为 HTTP-01 挑战由 nginx 的 /.well-known/acme-challenge/ location 提供。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=deploy/tls-lib.sh
. "$SCRIPT_DIR/tls-lib.sh"

zhixu_require_compose

DOMAIN="$(zhixu_resolve_domain "${1:-}")"
zhixu_assert_nginx_domain "$DOMAIN"

if [ ! -s "$ZHIXU_LIVE_DIR/fullchain.pem" ] || [ ! -s "$ZHIXU_LIVE_DIR/privkey.pem" ]; then
  zhixu_die "未找到证书。请先执行：bash deploy/tls-bootstrap.sh $DOMAIN"
fi

COMPOSE=(docker compose)
mkdir -p "$ZHIXU_WEBROOT"

if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx nginx; then
  echo "==> nginx 未运行，先启动"
  "${COMPOSE[@]}" up -d nginx
fi

echo "==> 校验 nginx 现有配置"
"${COMPOSE[@]}" exec -T nginx nginx -t

MARKER="$ZHIXU_WEBROOT/.renewed"
rm -f "$MARKER"

echo "==> certbot webroot 续期检查：$DOMAIN"
# certonly + --keep-until-expiring：未到期时不重签；到期时用 webroot 续期。
# 用 deploy-hook 写标记，避免 cron 每天都无条件 reload nginx。
"${COMPOSE[@]}" --profile tls run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  --non-interactive \
  --keep-until-expiring \
  --cert-name "$ZHIXU_CERT_NAME" \
  -d "$DOMAIN" \
  --deploy-hook "touch /var/www/certbot/.renewed"

if [ -f "$MARKER" ]; then
  rm -f "$MARKER"
  echo "==> 证书已续期，校验并重载 nginx"
  "${COMPOSE[@]}" exec -T nginx nginx -t
  "${COMPOSE[@]}" exec -T nginx nginx -s reload
  echo "nginx 已重载。"
else
  echo "证书尚未进入续期窗口，未重载 nginx。"
fi
