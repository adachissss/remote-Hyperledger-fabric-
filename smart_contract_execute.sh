#!/usr/bin/env bash

set -euo pipefail

# Resolve project root
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR" && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

usage() {
  cat <<'EOF'

用法: ./smart_contract_execute.sh <channel_name> <chaincode_name> <org_name> <action> <function_name> [args...]

参数提示:
- JSON 参数建议用单引号整体包裹。
- bookmark 为空时可传 ""。
- PDC 调用可追加：--transient-json '<私有JSON>'。
- transient key 默认 asset_private_data，可通过 --transient-key <key> 修改。
- 可通过 --target-orgs org1,org2 将背书请求限制到指定组织。
EOF
}

if [[ $# -lt 5 ]]; then
  usage
  exit 1
fi

CHANNEL_NAME=$1
CHAINCODE_NAME=$2
ORG_NAME_RAW=$3
ACTION=$4
FUNC_NAME=$5
shift 5

TRANSIENT_JSON=""
TRANSIENT_KEY="asset_private_data"
TARGET_ORGS=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --transient-json)
      [[ $# -ge 2 ]] || { error "ERROR: --transient-json 缺少 JSON 参数"; exit 1; }
      TRANSIENT_JSON="$2"
      shift 2
      ;;
    --target-orgs)
      [[ $# -ge 2 ]] || { error "ERROR: --target-orgs 缺少组织列表"; exit 1; }
      TARGET_ORGS="$2"
      shift 2
      ;;
    --transient-key)
      [[ $# -ge 2 ]] || { error "ERROR: --transient-key 缺少 key"; exit 1; }
      TRANSIENT_KEY="$2"
      shift 2
      ;;
    --)
      shift
      ARGS+=("$@")
      break
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "$ACTION" != "query" && "$ACTION" != "invoke" ]]; then
  error "ERROR: 第四个参数必须是 query 或 invoke"
  usage
  exit 1
fi

if ! command -v yq >/dev/null 2>&1; then
  error "ERROR: 未找到 yq，请先安装 (https://github.com/mikefarah/yq)"
  exit 1
fi

FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')

ORG_NAME=$(echo "$ORG_NAME_RAW" | tr '[:upper:]' '[:lower:]')
ORG_MSPID=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG_NAME}\") | .mspid")
ORG_DOMAIN=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG_NAME}\") | .domain")
PEER_HOST=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG_NAME}\") | .anchor_peers[0].host")
PEER_PORT=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG_NAME}\") | .anchor_peers[0].port")

if [[ -z "$ORG_MSPID" || "$ORG_MSPID" == "null" ]]; then
  error "ERROR: 未在配置中找到组织: $ORG_NAME_RAW"
  usage
  exit 1
fi

export CORE_PEER_LOCALMSPID="$ORG_MSPID"
export CORE_PEER_TLS_ROOTCERT_FILE=${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/peers/${PEER_HOST}/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/users/Admin@${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/msp
export CORE_PEER_ADDRESS=${PEER_HOST}:${PEER_PORT}
export FABRIC_CFG_PATH=${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${ORG_DOMAIN}/peers/${PEER_HOST}
IDENTITY_LABEL="${ORG_NAME} Admin"

# Peer client context (Org1 Admin)
export PATH=${PROJECT_ROOT}/bin:$PATH
export CORE_PEER_TLS_ENABLED=true
PEER_CONN_ARGS=()

org_is_target() {
  local candidate="$1"
  [[ -z "$TARGET_ORGS" ]] && return 0
  local selected
  IFS=',' read -ra selected <<< "$TARGET_ORGS"
  local item
  for item in "${selected[@]}"; do
    item=$(echo "$item" | xargs | tr '[:upper:]' '[:lower:]')
    [[ "$candidate" == "$item" ]] && return 0
  done
  return 1
}

while IFS= read -r ORG; do
  org_is_target "$ORG" || continue
  ORG_DOMAIN_ITEM=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .domain")
  PEER_HOST_ITEM=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .anchor_peers[0].host")
  PEER_PORT_ITEM=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .anchor_peers[0].port")
  PEER_ADDR_ITEM="${PEER_HOST_ITEM}:${PEER_PORT_ITEM}"
  PEER_TLS_ITEM="${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${ORG_DOMAIN_ITEM}/peers/${PEER_HOST_ITEM}/tls/ca.crt"
  PEER_CONN_ARGS+=(--peerAddresses "$PEER_ADDR_ITEM" --tlsRootCertFiles "$PEER_TLS_ITEM")
done < <(get_peer_org_names)

if [[ "$ACTION" == "invoke" && ${#PEER_CONN_ARGS[@]} -eq 0 ]]; then
  error "ERROR: --target-orgs 未匹配到任何已配置组织: ${TARGET_ORGS}"
  exit 1
fi

ORDERER_HOST=$(get_config_value_raw '.ordererOrg.nodes[0].host')
ORDERER_PORT=$(get_config_value_raw '.ordererOrg.nodes[0].port')
ORDERER_DOMAIN=$(get_config_value_raw '.ordererOrg.domain // .network.domain')
ORDERER_ADDR=${ORDERER_HOST}:${ORDERER_PORT}
ORDERER_TLS=${PROJECT_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/${ORDERER_HOST}/tls/ca.crt

# Build chaincode args JSON
CHAINCODE_PAYLOAD=$(python3 - "$FUNC_NAME" "${ARGS[@]}" <<'PY'
import json, sys
if len(sys.argv) < 2:
  print('{"Args":[]}')
  sys.exit(0)
func = sys.argv[1]
args = sys.argv[2:]
print(json.dumps({"Args": [func, *args]}))
PY
)

TRANSIENT_PAYLOAD=""
if [[ -n "$TRANSIENT_JSON" ]]; then
  TRANSIENT_PAYLOAD=$(python3 - "$TRANSIENT_KEY" "$TRANSIENT_JSON" <<'PY'
import base64, json, sys
key = sys.argv[1]
raw = sys.argv[2]
json.loads(raw)
encoded = base64.b64encode(raw.encode('utf-8')).decode('ascii')
print(json.dumps({key: encoded}))
PY
  )
fi

printf "链码执行脚本 (%s)\n" "$IDENTITY_LABEL"
printf "Channel : ${CHANNEL_NAME}\n"
printf "Chaincode: ${CHAINCODE_NAME}\n"
printf "Action   : ${ACTION}\n"
printf "Function : ${FUNC_NAME}\n"
echo "Args     : ${ARGS[*]:-<none>}"
if [[ -n "$TRANSIENT_JSON" ]]; then
  echo "Transient: ${TRANSIENT_KEY} (${#TRANSIENT_JSON} bytes, value redacted)"
fi
if [[ -n "$TARGET_ORGS" ]]; then
  echo "Targets  : $TARGET_ORGS"
fi


# 美观的多行命令展示
cat <<CMD


peer chaincode ${ACTION} \\
  -C ${CHANNEL_NAME} \\
  -n ${CHAINCODE_NAME} \\
  -c '${CHAINCODE_PAYLOAD}'

CMD

if [[ "$ACTION" == "invoke" ]]; then
  printf '  '
  printf '%q ' "${PEER_CONN_ARGS[@]}"
  printf '\n\n'
fi

cmd=(
  peer chaincode "$ACTION"
  -C "$CHANNEL_NAME"
  -n "$CHAINCODE_NAME"
  -c "$CHAINCODE_PAYLOAD"
)

if [[ -n "$TRANSIENT_PAYLOAD" ]]; then
  cmd+=(--transient "$TRANSIENT_PAYLOAD")
fi

if [[ "$ACTION" == "invoke" ]]; then
  cmd+=(
    -o "$ORDERER_ADDR"
    --ordererTLSHostnameOverride "$ORDERER_HOST"
    --tls
    --cafile "$ORDERER_TLS"
    "${PEER_CONN_ARGS[@]}"
    --waitForEvent
    --waitForEventTimeout 30s
  )
fi

# set -x
"${cmd[@]}"
