#!/usr/bin/env bash
set -euo pipefail

# 更新 docker 目录下 CA 与 Orderer 的 docker-compose 文件中 networks 字段，
# 依据 config/orgs.yaml 的 .network.name

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
CONFIG_FILE="${CONFIG_FILE:-${PROJECT_ROOT}/config/orgs.yaml}"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"
YQ_BIN="${YQ_BIN:-${PROJECT_ROOT}/bin/yq}"

DOCKER_CA_FILE="${PROJECT_ROOT}/docker/docker-compose-ca.yaml"
DOCKER_ORDERERS_FILE="${PROJECT_ROOT}/docker/docker-compose-orderers.yaml"

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || {
    error "错误：需要命令 '$cmd'，但未找到。"
    exit 1
  }
}

require_file() {
  local f="$1"
  [[ -f "$f" ]] || { error "错误：文件不存在 -> $f"; exit 1; }
}

[[ -x "$YQ_BIN" ]] || { error "错误：需要可执行文件 '$YQ_BIN'，但未找到。"; exit 1; }
require_cmd docker
require_file "$CONFIG_FILE"
require_file "$DOCKER_CA_FILE"
require_file "$DOCKER_ORDERERS_FILE"

FABRIC_DOCKER_NET="$("$YQ_BIN" -r '.network.name' "$CONFIG_FILE")"
if [[ -z "$FABRIC_DOCKER_NET" || "$FABRIC_DOCKER_NET" == "null" ]]; then
  error "错误：未能从 $CONFIG_FILE 读取 .network.name"
  exit 1
fi

debug "使用网络名：$FABRIC_DOCKER_NET (来源：$CONFIG_FILE)"

# 如网络不存在则创建
if ! docker network inspect "$FABRIC_DOCKER_NET" >/dev/null 2>&1; then
  warn "创建 Docker 网络：$FABRIC_DOCKER_NET"
  docker network create "$FABRIC_DOCKER_NET"
else
  debug "Docker 网络已存在：$FABRIC_DOCKER_NET"
fi

update_compose_networks() {
  local compose_file="$1"
  debug "更新 networks -> $FABRIC_DOCKER_NET: $compose_file"
  cp "$compose_file" "${compose_file}.bak"

  # 将所有服务的 networks 覆盖为单一网络名数组
  "$YQ_BIN" -i ".services.*.networks = [\"$FABRIC_DOCKER_NET\"]" "$compose_file"

  # 顶层 networks 设为 external: true 的该网络
  "$YQ_BIN" -i ".networks = { \"$FABRIC_DOCKER_NET\": { \"external\": true } }" "$compose_file"
}

update_compose_networks "$DOCKER_CA_FILE"
update_compose_networks "$DOCKER_ORDERERS_FILE"

info "完成：已更新 CA 与 Orderer 的 docker-compose 网络为 '$FABRIC_DOCKER_NET'。备份文件在同目录 *.bak。"
