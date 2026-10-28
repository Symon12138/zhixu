#!/usr/bin/env bash
# 记录当前应用镜像的不可变 ID 与 registry digest，供升级/回滚审计。
#
# 用法：bash deploy/record-release.sh [镜像引用]
#   不传参数时读取 .env 的 ZHIXU_IMAGE（例如 zhixu-study:1.0.1）。
# 输出：deploy/releases/<UTC 时间>.json
# 本机只 build 未 push 时 RepoDigests 可能为空，此时 imageId（sha256:...）仍可用于本机回滚。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=deploy/tls-lib.sh
. "$SCRIPT_DIR/tls-lib.sh"

IMAGE="${1:-${ZHIXU_IMAGE:-}}"
[ -n "$IMAGE" ] || IMAGE="$(zhixu_env_value ZHIXU_IMAGE)"
[ -n "$IMAGE" ] || zhixu_die "未指定镜像：请传入参数，或在 .env 设置 ZHIXU_IMAGE。"

command -v docker >/dev/null 2>&1 || zhixu_die "未找到 docker。"
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || zhixu_die "本机不存在镜像 $IMAGE；请先 docker compose build/pull。"

mkdir -p deploy/releases
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="deploy/releases/${STAMP}.json"
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
REPO_DIGESTS="$(docker image inspect "$IMAGE" --format '{{json .RepoDigests}}')"
[ -n "$REPO_DIGESTS" ] || REPO_DIGESTS="[]"

cat >"$FILE" <<JSON
{
  "recordedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "image": "$IMAGE",
  "imageId": "$IMAGE_ID",
  "repoDigests": $REPO_DIGESTS
}
JSON

echo "已记录发布镜像：$FILE"
cat "$FILE"
