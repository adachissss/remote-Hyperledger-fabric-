#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

FABRIC_NET_ID=$(get_config_value_raw '.network.id')
FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
MODE="${1:-apply}"

[[ -n "$FABRIC_NET_ID" && -n "$FABRIC_DOCKER_NET" && -n "$FABRIC_NET_PREFIX" ]] || {
  error "网络配置缺少 id、name 或 env_prefix"
  exit 1
}

BEGIN_MARKER="# BEGIN PLUS-FABRIC ${FABRIC_NET_ID}"
END_MARKER="# END PLUS-FABRIC ${FABRIC_NET_ID}"
TMP_MAPPING=$(mktemp "${TMPDIR:-/tmp}/plus-fabric-hosts.XXXXXX")
TMP_FILTERED=$(mktemp "${TMPDIR:-/tmp}/plus-fabric-hosts-filtered.XXXXXX")
trap 'rm -f "$TMP_MAPPING" "$TMP_FILTERED"' EXIT

command -v flock >/dev/null 2>&1 || {
  error "需要 flock 来串行更新 /etc/hosts，避免多个网络互相覆盖"
  exit 1
}
exec 9>/tmp/plus-fabric-hosts.lock
flock -x 9

remove_network_block() {
  sudo awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { skipping=1; next }
    $0 == end { skipping=0; next }
    !skipping { print }
  ' /etc/hosts > "$TMP_FILTERED"
  sudo tee /etc/hosts < "$TMP_FILTERED" >/dev/null
}

case "$MODE" in
  apply) ;;
  remove)
    remove_network_block
    success "Fabric hosts 映射已移除: $FABRIC_NET_ID"
    exit 0
    ;;
  *)
    error "用法: $0 [apply|remove]"
    exit 1
    ;;
esac

mapfile -t TARGET_HOSTS < <(
  {
    while IFS= read -r org; do
      [[ -n "$org" ]] || continue
      domain=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .domain")
      peer_count=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peer_count")
      for ((peer_index=0; peer_index<peer_count; peer_index++)); do
        echo "${FABRIC_NET_PREFIX}-peer${peer_index}.${domain}"
      done
    done < <(get_peer_org_names)
    get_config_value_raw '.ordererOrg.nodes[].host'
  } | awk 'NF && !seen[$0]++'
)

for host in "${TARGET_HOSTS[@]}"; do
  ip=$(docker inspect \
    --format "{{with index .NetworkSettings.Networks \"${FABRIC_DOCKER_NET}\"}}{{.IPAddress}}{{end}}" \
    "$host" 2>/dev/null || true)
  if [[ -n "$ip" ]]; then
    printf '%-15s %s\n' "$ip" "$host" >> "$TMP_MAPPING"
  else
    warn "容器未运行或未连接 Docker 网络，跳过 hosts 映射: $host"
  fi
done

[[ -s "$TMP_MAPPING" ]] || {
  error "未能从 Docker 网络 $FABRIC_DOCKER_NET 解析出 Fabric 节点"
  exit 1
}

debug "网络 $FABRIC_NET_ID 的 hosts 映射:"
cat "$TMP_MAPPING"

remove_network_block

{
  cat /etc/hosts
  echo "$BEGIN_MARKER"
  cat "$TMP_MAPPING"
  echo "$END_MARKER"
} | sudo tee /etc/hosts >/dev/null

success "Fabric hosts 更新完成: $FABRIC_NET_ID"
