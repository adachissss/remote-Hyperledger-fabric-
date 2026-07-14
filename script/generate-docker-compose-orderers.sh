#!/bin/bash
# 根据配置生成 docker/docker-compose-orderers.yaml

set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"

OUTPUT_FILE="${PROJECT_ROOT}/docker/docker-compose-orderers.yaml"
ORDERER_MSP_BASE="/var/hyperledger/orderer/msp"
ORDERER_TLS_BASE="/var/hyperledger/orderer/tls"
ORDERER_DATA_BASE="/var/hyperledger/production/orderer"
ORDERER_OPERATIONS_PORT_BASE=9443

get_orderer_admin_port() {
  local orderer_port="$1"
  local explicit_admin_port="$2"
  if [[ -n "$explicit_admin_port" && "$explicit_admin_port" != "null" ]]; then
    echo "$explicit_admin_port"
    return 0
  fi
  echo $((orderer_port + 3))
}

get_orderer_ops_port() {
  local orderer_index="$1"
  local explicit_ops_port="$2"
  if [[ -n "$explicit_ops_port" && "$explicit_ops_port" != "null" ]]; then
    echo "$explicit_ops_port"
    return 0
  fi
  echo $((ORDERER_OPERATIONS_PORT_BASE + orderer_index))
}

write_orderer_service() {
  local host="$1"
  local port="$2"
  local admin_port="$3"
  local ops_port="$4"
  local mspid="$5"
  local domain="$6"

  cat >> "$OUTPUT_FILE" <<EOF
  ${host}:
    container_name: ${host}
    image: hyperledger/fabric-orderer:latest
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - ORDERER_GENERAL_LISTENADDRESS=0.0.0.0
      - ORDERER_GENERAL_LISTENPORT=${port}
      - ORDERER_GENERAL_LOCALMSPID=${mspid}
      - ORDERER_GENERAL_LOCALMSPDIR=${ORDERER_MSP_BASE}
      - ORDERER_GENERAL_TLS_ENABLED=true
      - ORDERER_GENERAL_TLS_PRIVATEKEY=${ORDERER_TLS_BASE}/server.key
      - ORDERER_GENERAL_TLS_CERTIFICATE=${ORDERER_TLS_BASE}/server.crt
      - ORDERER_GENERAL_TLS_ROOTCAS=[${ORDERER_TLS_BASE}/ca.crt]
      - ORDERER_GENERAL_TLS_CLIENTROOTCAS=[${ORDERER_TLS_BASE}/ca.crt]
      - ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=${ORDERER_TLS_BASE}/server.crt
      - ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=${ORDERER_TLS_BASE}/server.key
      - ORDERER_GENERAL_CLUSTER_ROOTCAS=[${ORDERER_TLS_BASE}/ca.crt]
      - ORDERER_GENERAL_BOOTSTRAPMETHOD=none
      - ORDERER_GENERAL_BOOTSTRAPFILE=""
      - ORDERER_ADMIN_TLS_ENABLED=true
      - ORDERER_ADMIN_TLS_CERTIFICATE=${ORDERER_TLS_BASE}/server.crt
      - ORDERER_ADMIN_TLS_PRIVATEKEY=${ORDERER_TLS_BASE}/server.key
      - ORDERER_ADMIN_TLS_ROOTCAS=[${ORDERER_TLS_BASE}/ca.crt]
      - ORDERER_ADMIN_TLS_CLIENTROOTCAS=[${ORDERER_TLS_BASE}/ca.crt]
      - ORDERER_ADMIN_TLS_CLIENTAUTHREQUIRED=true
      - ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:${admin_port}
      - ORDERER_CHANNELPARTICIPATION_ENABLED=true
      - ORDERER_OPERATIONS_LISTENADDRESS=${host}:${ops_port}
      - ORDERER_METRICS_PROVIDER=prometheus
    working_dir: /root
    command: orderer
    volumes:
      - ../organizations/ordererOrganizations/${domain}/orderers/${host}/msp:${ORDERER_MSP_BASE}
      - ../organizations/ordererOrganizations/${domain}/orderers/${host}/tls:${ORDERER_TLS_BASE}
      - ${host}:${ORDERER_DATA_BASE}
    ports:
      - ${port}:${port}
      - ${admin_port}:${admin_port}
      - ${ops_port}:${ops_port}
    networks:
      - ${FABRIC_DOCKER_NET}
EOF
}

FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')
ORDERER_CONFIG=$(load_orderer_org_config)
ORDERER_MSPID=$(printf '%s' "$ORDERER_CONFIG" | "$YQ_BIN" -r '.mspid')
ORDERER_DOMAIN=$(printf '%s' "$ORDERER_CONFIG" | "$YQ_BIN" -r '.domain')
mapfile -t ORDERER_NODES < <(printf '%s' "$ORDERER_CONFIG" | "$YQ_BIN" -r '.nodes[] | "\(.host)|\(.port)|\(.admin_port // "")|\(.operations_port // "")"')

debug "正在根据 $CONFIG_FILE 生成 docker-compose-orderers.yaml"
debug "输出文件: $OUTPUT_FILE"
info "=================================================="

cat > "$OUTPUT_FILE" <<EOF
version: '3.7'
services:
EOF

declare -a ORDERER_VOLUMES=()
orderer_index=0
for node_line in "${ORDERER_NODES[@]}"; do
  IFS='|' read -r orderer_host orderer_port orderer_admin_override orderer_ops_override <<< "$node_line"
  admin_port=$(get_orderer_admin_port "$orderer_port" "$orderer_admin_override")
  ops_port=$(get_orderer_ops_port "$orderer_index" "$orderer_ops_override")

  write_orderer_service \
    "$orderer_host" \
    "$orderer_port" \
    "$admin_port" \
    "$ops_port" \
    "$ORDERER_MSPID" \
    "$ORDERER_DOMAIN"

  ORDERER_VOLUMES+=("  ${orderer_host}:")
  orderer_index=$((orderer_index + 1))
done

cat >> "$OUTPUT_FILE" <<EOF
volumes:
$(printf "%s\n" "${ORDERER_VOLUMES[@]}")
networks:
  ${FABRIC_DOCKER_NET}:
    external: true
EOF

log_success "\nOrderer compose 生成完成！"
success "   输出文件: $OUTPUT_FILE"
success "   Orderer 节点数量: ${#ORDERER_NODES[@]}"
info "=================================================="
