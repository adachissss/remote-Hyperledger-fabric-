#!/bin/bash

# 用法示例：
#   source setGlobals.sh org1
#   source setGlobals.sh org2

# ====================== 自动计算路径======================
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

# 读取 config/orgs.yaml 中的网络前缀
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')

setGlobals() {
  ORG=$1
  PEER="peer0"

  ORG_MSPID=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .mspid")
  ORG_DOMAIN=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .domain")
  NETWORK_DOMAIN=$(get_config_value_raw '.network.domain // .ordererOrg.domain')
  PEER_HOST=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .anchor_peers[0].host")
  PEER_PORT=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .anchor_peers[0].port")

  if [[ -z "$ORG_MSPID" || "$ORG_MSPID" == "null" ]]; then
    error "Unknown organization: $ORG"
    return 1
  fi

  export CORE_PEER_LOCALMSPID="$ORG_MSPID"
  export CORE_PEER_TLS_ROOTCERT_FILE=${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/peers/${PEER_HOST}/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/users/Admin@${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/msp
  export CORE_PEER_ADDRESS=${PEER_HOST}:${PEER_PORT}
  export FABRIC_CFG_PATH=${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/peers/${PEER_HOST}
  case ",${NO_PROXY:-}," in
    *,".${ORG_DOMAIN}",*) ;;
    *) NO_PROXY="${NO_PROXY:+${NO_PROXY},}.${ORG_DOMAIN}" ;;
  esac
  case ",${NO_PROXY}," in
    *,".${NETWORK_DOMAIN}",*) ;;
    *) NO_PROXY="${NO_PROXY},.${NETWORK_DOMAIN}" ;;
  esac
  export NO_PROXY
  export no_proxy="$NO_PROXY"
  debug "切换到 $ORG"

  success "环境变量已设置: $ORG ($CORE_PEER_ADDRESS)"
}

# 如果直接运行脚本，则提示使用方法
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  warn "请用 source 加载此脚本: source setGlobals.sh org1/org2/org3"
fi
