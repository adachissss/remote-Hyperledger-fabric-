#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_FILE="${PROJECT_ROOT}/config/orgs.yaml"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

# ==============================
# 读取 Fabric 网络参数
# ==============================
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')

if [[ -z "$FABRIC_NET_PREFIX" || -z "$FABRIC_DOCKER_NET" ]]; then
  error "orgs.yaml 中缺少 network.env_prefix 或 network.name"
  exit 1
fi

debug "Fabric 网络前缀: $FABRIC_NET_PREFIX"
debug "Docker 网络名:   $FABRIC_DOCKER_NET"

# ==============================
# 从 docker network 获取权威映射
# ==============================
debug "从 Docker Network 读取容器 IP..."
NETWORK_JSON=$(docker inspect "$FABRIC_DOCKER_NET")

TMP_FILE="/tmp/fabric-hosts-${FABRIC_NET_PREFIX}"
> "$TMP_FILE"

echo "$NETWORK_JSON" \
| jq -r '.[] .Containers | to_entries[]
         | "\(.value.Name) \(.value.IPv4Address)"' \
| while read -r name ip; do

    clean_ip="${ip%/*}"

    # ===== Peer（带网络前缀）=====
    if [[ "$name" =~ ^${FABRIC_NET_PREFIX}-peer[0-9]+\.org[0-9]+\.example\.com$ ]]; then
        printf "%-15s %s\n" "$clean_ip" "$name" >> "$TMP_FILE"
    fi

    # ===== Orderer（无网络前缀）=====
    if [[ "$name" =~ ^orderer[0-9]+\.example\.com$ ]]; then
        printf "%-15s %s\n" "$clean_ip" "$name" >> "$TMP_FILE"
    fi
done

if [[ ! -s "$TMP_FILE" ]]; then
  error "未能从 docker network 中解析出任何 Fabric 节点"
  exit 1
fi

debug "生成的 hosts 映射："
cat "$TMP_FILE"

# ==============================
# 写入 /etc/hosts
# ==============================
warn "更新 /etc/hosts（需要 sudo）..."

# 删除旧的同网络 peer
sudo sed -i.bak "/${FABRIC_NET_PREFIX}-peer[0-9]\+\.org[0-9]\+\.example\.com/d" /etc/hosts

# 删除旧的 orderer
sudo sed -i "/orderer[0-9]\+\.example\.com/d" /etc/hosts

# 写入新映射
sudo tee -a /etc/hosts < "$TMP_FILE" > /dev/null

info "Fabric hosts 更新完成"
