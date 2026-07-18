#!/bin/bash
# scripts/generate-docker-compose-peers.sh
# 一键根据 config/orgs.yaml 生成 docker-compose-peers.yaml
# 支持任意组织、任意数量 peer、自动端口分配、自动 Leader 选举

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"

OUTPUT_FILE="${PROJECT_ROOT}/docker/docker-compose-peers.yaml"

debug "正在根据 $CONFIG_FILE 生成 docker-compose-peers.yaml"
debug "输出文件: $OUTPUT_FILE"
echo "=================================================="

PORT_SLOT_STRIDE=10
PORT_ORG_STRIDE=100
PORT_BASE_START=7000

get_component_offset() {
  local component="${1:-peer}"
  case "$component" in
    peer) echo 51 ;;
    chaincode) echo 52 ;;
    metrics) echo 55 ;;
    couchdb) echo 58 ;;
    *) log_error "未知组件: $component"; exit 1 ;;
  esac
}

get_port_override() {
  local org_name="$1"
  local peer_index="$2"
  local component="$3"
  local field

  case "$component" in
    peer) field='peer_port' ;;
    chaincode) field='chaincode_port' ;;
    metrics) field='metrics_port' ;;
    couchdb) field='couchdb_port' ;;
    *) log_error "未知组件: $component"; exit 1 ;;
  esac

  local override
  override=$("$YQ_BIN" -r ".peerOrgs[] | select(.name == \"${org_name}\") | .peers[${peer_index}].${field} // empty" "$CONFIG_FILE")
  if [[ -n "$override" && "$override" != "null" ]]; then
    echo "$override"
    return 0
  fi
  return 1
}

get_port() {
  local org_name="$1"
  local peer_index="$2"
  local component="${3:-peer}"

  local override
  if override=$(get_port_override "$org_name" "$peer_index" "$component"); then
    echo "$override"
    return 0
  fi

  local org_index
  org_index=$(get_peer_org_index "$org_name")
  local component_offset
  component_offset=$(get_component_offset "$component")
  local base=$((PORT_BASE_START + org_index * PORT_ORG_STRIDE))
  echo $((base + peer_index * PORT_SLOT_STRIDE + component_offset))
}

cat > "$OUTPUT_FILE" <<'EOF'
services:
EOF

# 收集所有 volumes
declare -a ALL_VOLUMES=()

# 遍历所有 Peer 组织
mapfile -t PEER_ORGS < <(get_peer_org_names)

FABRIC_NET_ID=$(get_config_value_raw '.network.id')
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')
FABRIC_NET_PORT=$(get_config_value_raw '.network.network_port__start // 0')
FABRIC_IMAGE_TAG=$(get_config_value_raw '.network.fabric_version // "latest"')
STATE_DATABASE=$(get_config_value_raw '.network.state_database // "leveldb"')
COUCHDB_IMAGE=$(get_config_value_raw '.network.couchdb_image // "couchdb:3.3.3"')


for org in "${PEER_ORGS[@]}"; do
  ORG_CONFIG=$(load_peer_org_config "$org")
  MSPID=$(printf '%s' "$ORG_CONFIG" | "$YQ_BIN" -r '.mspid')
  DOMAIN=$(printf '%s' "$ORG_CONFIG" | "$YQ_BIN" -r '.domain')
  PEER_COUNT=$(printf '%s' "$ORG_CONFIG" | "$YQ_BIN" -r '.peer_count')
  ORG_INDEX=$(get_peer_org_index "$org")

  debug "正在生成组织 $org ($DOMAIN) 的 $PEER_COUNT 个 Peer..."

  for ((i=0; i<PEER_COUNT; i++)); do
    PEER_NAME="peer$i"
    PEER_HOST="${FABRIC_NET_PREFIX}-${PEER_NAME}.${DOMAIN}"
    PORT=$(get_port "$org" "$i" peer)
    CHAINCODE_PORT=$(get_port "$org" "$i" chaincode)
    METRICS_PORT=$(get_port "$org" "$i" metrics)
    COUCHDB_PORT=$(get_port "$org" "$i" couchdb)
    HOST_PORT=$((FABRIC_NET_PORT + PORT))
    HOST_METRICS_PORT=$((FABRIC_NET_PORT + METRICS_PORT))
    HOST_COUCHDB_PORT=$((FABRIC_NET_PORT + COUCHDB_PORT))

    # 所有 peer 都独立从 orderer 拉取区块，bootstrap 指向本组织 peer0
    BOOTSTRAP_PORT=$(get_port "$org" 0 peer)
    BOOTSTRAP_HOST="peer0.${DOMAIN}"
    BOOTSTRAP="${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}"

    ORGLEADER="true"
    USELEADERELECTION="false"

    COUCHDB_PEER_SETTINGS="      - CORE_LEDGER_STATE_STATEDATABASE=goleveldb"
    COUCHDB_DEPENDS_ON=""
    if [[ "$STATE_DATABASE" == "couchdb" ]]; then
      COUCHDB_HOST=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peers[${i}].couchdb_host // empty")
      COUCHDB_HOST="${COUCHDB_HOST:-${PEER_HOST}-couchdb}"
      COUCHDB_USERNAME=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peers[${i}].couchdb_username // \"admin\"")
      COUCHDB_PASSWORD=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peers[${i}].couchdb_password // \"adminpw\"")

      cat >> "$OUTPUT_FILE" <<EOF

  ${COUCHDB_HOST}:
    container_name: ${COUCHDB_HOST}
    image: ${COUCHDB_IMAGE}
    environment:
      - COUCHDB_USER=${COUCHDB_USERNAME}
      - COUCHDB_PASSWORD=${COUCHDB_PASSWORD}
    ports:
      - ${HOST_COUCHDB_PORT}:5984
    volumes:
      - ${COUCHDB_HOST}:/opt/couchdb/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS -u ${COUCHDB_USERNAME}:${COUCHDB_PASSWORD} http://127.0.0.1:5984/_up || exit 1"]
      interval: 3s
      timeout: 2s
      retries: 20
    networks:
      - ${FABRIC_DOCKER_NET}
EOF
      ALL_VOLUMES+=("  ${COUCHDB_HOST}:")
      COUCHDB_PEER_SETTINGS=$(printf '%s\n' \
        "      - CORE_LEDGER_STATE_STATEDATABASE=CouchDB" \
        "      - CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS=${COUCHDB_HOST}:5984" \
        "      - CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=${COUCHDB_USERNAME}" \
        "      - CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD=${COUCHDB_PASSWORD}")
      COUCHDB_DEPENDS_ON=$(printf '%s\n' \
        "    depends_on:" \
        "      ${COUCHDB_HOST}:" \
        "        condition: service_healthy")
    fi


    cat >> "$OUTPUT_FILE" <<EOF

  ${PEER_HOST}:
    container_name: ${PEER_HOST}
    image: hyperledger/fabric-peer:${FABRIC_IMAGE_TAG}
    labels:
      service: hyperledger-fabric
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - CORE_PEER_PROFILE_ENABLED=false

      # 身份与地址
      - CORE_PEER_ID=${PEER_HOST}
      - CORE_PEER_ADDRESS=${PEER_HOST}:${PORT}
      - CORE_PEER_LISTENADDRESS=0.0.0.0:${PORT}
      - CORE_PEER_CHAINCODEADDRESS=${PEER_HOST}:${CHAINCODE_PORT}
      - CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:${CHAINCODE_PORT}

      # MSP
      - CORE_PEER_LOCALMSPID=${MSPID}
      - CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/fabric/msp

      # 数据持久化
      - CORE_PEER_FILESYSTEMPATH=/var/hyperledger/production

      # TLS
      - CORE_PEER_TLS_ENABLED=true
      - CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt
      - CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key
      - CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt
      - CORE_PEER_TLS_CLIENTAUTHREQUIRED=false


      # Gossip
      - CORE_PEER_GOSSIP_BOOTSTRAP=${FABRIC_NET_PREFIX}-${BOOTSTRAP}
      - CORE_PEER_GOSSIP_EXTERNALENDPOINT=${PEER_HOST}:${PORT}
      - CORE_PEER_GOSSIP_ORGLEADER=${ORGLEADER}
      - CORE_PEER_GOSSIP_USELEADERELECTION=${USELEADERELECTION}
      - CORE_PEER_DELIVERYCLIENT_BLOCKGOSSIPENABLED=false

${COUCHDB_PEER_SETTINGS}

      - CORE_OPERATIONS_LISTENADDRESS=0.0.0.0:${METRICS_PORT}
      - CORE_OPERATIONS_TLS_ENABLED=false
      - CORE_METRICS_PROVIDER=prometheus
      - CORE_VM_ENDPOINT=unix:///var/run/docker.sock
      - CORE_VM_DOCKER_HOSTCONFIG_NETWORKMODE=${FABRIC_DOCKER_NET}
      # 链码配置
      - CORE_CHAINCODE_MODE=net
      - CORE_CHAINCODE_BUILDER=hyperledger/fabric-ccenv:${FABRIC_IMAGE_TAG}
      - CORE_CHAINCODE_EXECUTETIMEOUT=180s
      - CORE_CHAINCODE_INSTALLTIMEOUT=180s
      - CORE_CHAINCODE_STARTUPTIMEOUT=180s
      - CORE_CHAINCODE_EXTERNALBUILDERS=[]
${COUCHDB_DEPENDS_ON}
    volumes:
      - ../organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${DOMAIN}/peers/${PEER_HOST}/msp:/etc/hyperledger/fabric/msp
      - ../organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${DOMAIN}/peers/${PEER_HOST}/tls:/etc/hyperledger/fabric/tls
      - ${PEER_HOST}:/var/hyperledger/production
      - ../organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${DOMAIN}/users/Admin@${FABRIC_NET_PREFIX}-${DOMAIN}/msp:/etc/hyperledger/fabric/admin/msp
      - ../chaincode:/etc/hyperledger/fabric/chaincode
      - /var/run/docker.sock:/var/run/docker.sock
    working_dir: /root
    command: peer node start
    ports:
      - ${HOST_PORT}:${PORT}
      - ${HOST_METRICS_PORT}:${METRICS_PORT}
    networks:
      - ${FABRIC_DOCKER_NET}
EOF

    ALL_VOLUMES+=("  ${PEER_HOST}:")
  done
done

# 写入 volumes 和 networks
cat >> "$OUTPUT_FILE" <<EOF

volumes:
$(printf "%s\n" "${ALL_VOLUMES[@]}")

networks:
  ${FABRIC_DOCKER_NET}:
    external: true
EOF

log_success "\n生成完成！"
success "   输出文件: $OUTPUT_FILE"
success "   共生成 ${#ALL_VOLUMES[@]} 个 Peer 节点"
success "   端口分配规则：默认从 ${PORT_BASE_START} 起，按组织步长 ${PORT_ORG_STRIDE}、按 peer 步长 ${PORT_SLOT_STRIDE} 自动推导；也支持在配置中为单个 peer 显式覆盖端口"
success "   所有 peer 都独立从 orderer 拉取区块"
echo "=================================================="
