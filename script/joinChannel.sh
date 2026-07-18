#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${PROJECT_ROOT}/script/env.sh" "${1:-${CHANNEL_NAME:-}}"

CHANNEL_BLOCK="${PROJECT_ROOT}/channel-artifacts/${CHANNEL_NAME}.block"
ORDERER_TLS_CA="$ORDERER_CA"

FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
mapfile -t CHANNEL_MEMBER_ORGS < <(get_channel_member_orgs "$CHANNEL_NAME")

belongs_to_channel_org() {
  local mspid="$1"
  local org
  for org in "${CHANNEL_MEMBER_ORGS[@]}"; do
    [[ -z "$org" ]] && continue
    if [[ "$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .mspid")" == "$mspid" ]]; then
      return 0
    fi
  done
  return 1
}

# ====================== 获取所有运行中的 Peer ======================
get_all_peers() {
  log_debug "get_all_peers: 开始获取 peer 列表"
  local count=0
  local org domain peer_count container addr msp
  for org in "${CHANNEL_MEMBER_ORGS[@]}"; do
    [[ -n "$org" ]] || continue
    domain=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .domain")
    peer_count=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peer_count")
    for ((peer_index=0; peer_index<peer_count; peer_index++)); do
      container="${FABRIC_NET_PREFIX}-peer${peer_index}.${domain}"
      addr=$(docker inspect --format='{{range .Config.Env}}{{if eq (index (split . "=") 0) "CORE_PEER_ADDRESS"}}{{index (split . "=") 1}}{{end}}{{end}}' "$container" 2>/dev/null || true)
      msp=$(docker inspect --format='{{range .Config.Env}}{{if eq (index (split . "=") 0) "CORE_PEER_LOCALMSPID"}}{{index (split . "=") 1}}{{end}}{{end}}' "$container" 2>/dev/null || true)
      if [[ -n "$addr" && -n "$msp" ]]; then
        printf '%s|%s|%s\n' "$container" "$addr" "$msp"
        ((count++)) || true
      else
        log_warning "get_all_peers: 跳过未运行或配置不完整的容器 $container"
      fi
    done
  done

  log_debug "get_all_peers: 完成,共找到 $count 个 peer"
}

# ====================== 设置环境变量 ======================
set_peer_env() {
  local peer_host="$1" address="$2" mspid="$3"
  local domain="${FABRIC_NET_PREFIX}-${peer_host#*.}"
  local peer_dir="${PROJECT_ROOT}/organizations/peerOrganizations/${domain}/peers/${peer_host}"
  local peer_tls_dir="${peer_dir}/tls"
  local peer_core_dir="$peer_dir"

  [[ -f "${peer_core_dir}/core.yaml" ]] || {
    log_error "未找到 peer 专属 core.yaml: ${peer_core_dir}/core.yaml"
    exit 1
  }

  export FABRIC_CFG_PATH="$peer_core_dir"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="$mspid"
  export CORE_PEER_MSPCONFIGPATH="${PROJECT_ROOT}/organizations/peerOrganizations/${domain}/users/Admin@${domain}/msp"
  export CORE_PEER_ADDRESS="$address"
  export CORE_PEER_TLS_ROOTCERT_FILE="${peer_tls_dir}/ca.crt"
  export CORE_PEER_TLS_CLIENTCERT_FILE="${peer_tls_dir}/server.crt"
  export CORE_PEER_TLS_CLIENTKEY_FILE="${peer_tls_dir}/server.key"

  log_debug "环境变量已设置 → $peer_host ($address) MSP=$mspid FABRIC_CFG_PATH=$FABRIC_CFG_PATH"
}

# ====================== 加入通道 ======================
join_channel() {
  local peer_host="$1"
  log_debug "[$peer_host] 正在加入通道 $CHANNEL_NAME ..."

  # 检查是否已加入
  if peer channel list 2>/dev/null | grep -q "^${CHANNEL_NAME}$"; then
    log_warning "[$peer_host] 已加入通道,跳过"
    return 0
  fi

  log_debug "[$peer_host] 执行 peer channel join"
  debug "────────────────────────────────────────────────────────────────────"

  if timeout 30 peer channel join -b "$CHANNEL_BLOCK" --clientauth; then
    log_success "[$peer_host] 成功加入通道 $CHANNEL_NAME"
    return 0
  else
    log_error "[$peer_host] 加入通道失败！完整错误已在上方显示"
    return 1
  fi
}


# ====================== 主函数 ======================
main() {
  log_info "=============== 开始一键加入通道 + 更新锚节点 ==============="
  log_debug "PROJECT_ROOT=$PROJECT_ROOT"
  log_debug "CHANNEL_BLOCK=$CHANNEL_BLOCK"
  log_debug "ORDERER_TLS_CA=$ORDERER_TLS_CA"

  log_debug "检查文件是否存在..."
  [[ ${#CHANNEL_MEMBER_ORGS[@]} -gt 0 ]] || { log_error "通道 $CHANNEL_NAME 未配置 memberOrgs"; exit 1; }
  log_debug "通道成员组织: ${CHANNEL_MEMBER_ORGS[*]}"
  [[ -f "$CHANNEL_BLOCK" ]]   || { log_error "创世块不存在: $CHANNEL_BLOCK"; exit 1; }
  log_debug "创世块存在: $CHANNEL_BLOCK"

  [[ -f "$ORDERER_TLS_CA" ]]  || { log_error "Orderer CA 不存在: $ORDERER_TLS_CA"; exit 1; }
  log_debug "Orderer CA 存在: $ORDERER_TLS_CA"

  local total=0 success=0

  mapfile -t peers < <(get_all_peers)


  log_debug "开始遍历 peers 数组..."
  for peer_line in "${peers[@]}"; do
    if [[ -z "$peer_line" ]]; then
      log_warning "peer_line 为空,跳过"
      continue
    fi

    IFS='|' read -r peer_host address mspid <<< "$peer_line"

    ((total++)) || true
    log_debug "[$(printf "%2d" $total)/12] 处理 $peer_host → $address"


    set_peer_env "$peer_host" "$address" "$mspid"

    if join_channel "$peer_host"; then
      ((success++)) || true
      log_debug "join_channel 成功,success=$success"
    else
      log_debug "join_channel 失败"
    fi
  done

  log_debug "循环结束,total=$total, success=$success"
  log_info "通道加入完成！成功 $success / $total 个 Peer"

}

main
