#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
else
  SCRIPT_DIR="${PROJECT_ROOT}/script"
fi

DEFAULT_OUTPUT_FILE="${PROJECT_ROOT}/config/orgs.yaml"
: "${CONFIG_FILE:="$DEFAULT_OUTPUT_FILE"}"
ORIGINAL_CONFIG_FILE="$CONFIG_FILE"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

OUTPUT_FILE="$ORIGINAL_CONFIG_FILE"
NETWORK_NAME=""
ENV_PREFIX=""
PEER_ORG_COUNT=""
PEERS_PER_ORG=""
ORDERER_COUNT=""
DOMAIN="example.com"
NETWORK_ID=""
NETWORK_PORT_START=0
PEER_ADMIN_PASSWORD="adminpw"
ORDERER_ADMIN_PASSWORD="adminpw"
ANCHOR_PEERS_PER_ORG=2

usage() {
  cat <<'EOF'
用法:
  ./config/generate-orgs-config.sh \
    --network-name <name> \
    --env-prefix <prefix> \
    --peer-org-count <n> \
    --peers-per-org <n> \
    --orderer-count <n> \
    [--domain <domain>] \
    [--network-id <id>] \
    [--network-port-start <n>] \
    [--peer-admin-password <pw>] \
    [--orderer-admin-password <pw>] \
    [--anchor-peers-per-org <n>] \
    [--output <path>]

示例:
  ./config/generate-orgs-config.sh \
    --network-name test-net \
    --env-prefix TESTNET \
    --peer-org-count 2 \
    --peers-per-org 2 \
    --orderer-count 3
EOF
}

require_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || { error "参数 $flag 需要一个值"; exit 1; }
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_non_negative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

validate_network_name() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
}

validate_env_prefix() {
  [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]]
}

validate_domain() {
  [[ "$1" =~ ^[a-zA-Z0-9.-]+$ ]]
}

get_peer_port() {
  local org_index_zero_based="$1"
  local peer_index_zero_based="$2"
  echo $((7000 + org_index_zero_based * 100 + peer_index_zero_based * 10 + 51))
}

get_peer_ca_port() {
  local org_index_one_based="$1"
  echo $((7054 + (org_index_one_based - 1) * 1000))
}

get_orderer_port() {
  local orderer_index_one_based="$1"
  echo $((7050 + (orderer_index_one_based - 1) * 1000))
}

get_orderer_ca_port() {
  local peer_org_count="$1"
  echo $((7000 + peer_org_count * 1000 + 54))
}

backup_existing_config() {
  if [[ -f "$OUTPUT_FILE" ]]; then
    cp "$OUTPUT_FILE" "${OUTPUT_FILE}.bak"
    warn "已备份原配置: ${OUTPUT_FILE}.bak"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --network-name)
        require_value "$1" "${2:-}"
        NETWORK_NAME="$2"
        shift 2
        ;;
      --env-prefix)
        require_value "$1" "${2:-}"
        ENV_PREFIX="$2"
        shift 2
        ;;
      --peer-org-count)
        require_value "$1" "${2:-}"
        PEER_ORG_COUNT="$2"
        shift 2
        ;;
      --peers-per-org)
        require_value "$1" "${2:-}"
        PEERS_PER_ORG="$2"
        shift 2
        ;;
      --orderer-count)
        require_value "$1" "${2:-}"
        ORDERER_COUNT="$2"
        shift 2
        ;;
      --domain)
        require_value "$1" "${2:-}"
        DOMAIN="$2"
        shift 2
        ;;
      --network-id)
        require_value "$1" "${2:-}"
        NETWORK_ID="$2"
        shift 2
        ;;
      --network-port-start)
        require_value "$1" "${2:-}"
        NETWORK_PORT_START="$2"
        shift 2
        ;;
      --peer-admin-password)
        require_value "$1" "${2:-}"
        PEER_ADMIN_PASSWORD="$2"
        shift 2
        ;;
      --orderer-admin-password)
        require_value "$1" "${2:-}"
        ORDERER_ADMIN_PASSWORD="$2"
        shift 2
        ;;
      --anchor-peers-per-org)
        require_value "$1" "${2:-}"
        ANCHOR_PEERS_PER_ORG="$2"
        shift 2
        ;;
      --output)
        require_value "$1" "${2:-}"
        OUTPUT_FILE="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        error "未知参数: $1"
        usage
        exit 1
        ;;
    esac
  done
}

validate_args() {
  [[ -n "$NETWORK_NAME" ]] || { error "缺少参数 --network-name"; exit 1; }
  [[ -n "$ENV_PREFIX" ]] || { error "缺少参数 --env-prefix"; exit 1; }
  [[ -n "$PEER_ORG_COUNT" ]] || { error "缺少参数 --peer-org-count"; exit 1; }
  [[ -n "$PEERS_PER_ORG" ]] || { error "缺少参数 --peers-per-org"; exit 1; }
  [[ -n "$ORDERER_COUNT" ]] || { error "缺少参数 --orderer-count"; exit 1; }

  validate_network_name "$NETWORK_NAME" || { error "--network-name 格式非法: $NETWORK_NAME"; exit 1; }
  validate_env_prefix "$ENV_PREFIX" || { error "--env-prefix 格式非法: $ENV_PREFIX"; exit 1; }
  validate_domain "$DOMAIN" || { error "--domain 格式非法: $DOMAIN"; exit 1; }

  is_positive_integer "$PEER_ORG_COUNT" || { error "--peer-org-count 必须是正整数"; exit 1; }
  is_positive_integer "$PEERS_PER_ORG" || { error "--peers-per-org 必须是正整数"; exit 1; }
  is_positive_integer "$ORDERER_COUNT" || { error "--orderer-count 必须是正整数"; exit 1; }
  is_positive_integer "$ANCHOR_PEERS_PER_ORG" || { error "--anchor-peers-per-org 必须是正整数"; exit 1; }
  is_non_negative_integer "$NETWORK_PORT_START" || { error "--network-port-start 必须是非负整数"; exit 1; }

  if [[ -z "$NETWORK_ID" ]]; then
    NETWORK_ID="${NETWORK_NAME}-001"
  fi

  if (( ANCHOR_PEERS_PER_ORG > PEERS_PER_ORG )); then
    warn "anchor peer 数量超过 peer 数量，自动截断为 $PEERS_PER_ORG"
    ANCHOR_PEERS_PER_ORG=$PEERS_PER_ORG
  fi

  if (( ORDERER_COUNT % 2 == 0 )); then
    warn "当前 orderer 数量为偶数，etcdraft 通常更推荐奇数节点"
  fi

  local output_dir
  output_dir="$(dirname "$OUTPUT_FILE")"
  [[ -d "$output_dir" ]] || { error "输出目录不存在: $output_dir"; exit 1; }
}

write_network_section() {
  cat <<EOF
network:
  domain: ${DOMAIN}
  tls_enabled: true
  aggregate_all_tls_roots: true
  name: ${NETWORK_NAME}
  id: ${NETWORK_ID}
  env_prefix: ${ENV_PREFIX}
  network_port__start: ${NETWORK_PORT_START}
  state_database: leveldb
  couchdb_image: couchdb:3.3.3
EOF
}

write_orderer_section() {
  local orderer_ca_port
  orderer_ca_port=$(get_orderer_ca_port "$PEER_ORG_COUNT")

  cat <<EOF
ordererOrg:
  mspid: OrdererMSP
  domain: ${DOMAIN}
  consensus_type: etcdraft
  batch_timeout_seconds: 2
  batch_size:
    max_message_count: 10
    absolute_max_bytes_mib: 99
    preferred_max_bytes_kib: 512
  ca_url: https://localhost:${orderer_ca_port}
  ca_name: ca-orderer
  ca_tls_cert: organizations/fabric-ca/ca-orderer/ca-cert.pem
  nodes:
EOF

  local i orderer_name orderer_host orderer_port
  for ((i=1; i<=ORDERER_COUNT; i++)); do
    orderer_name="orderer${i}"
    orderer_host="${orderer_name}.${DOMAIN}"
    orderer_port=$(get_orderer_port "$i")
    cat <<EOF
    - name: ${orderer_name}
      host: ${orderer_host}
      port: ${orderer_port}
EOF
  done

  cat <<EOF
  admin_password: ${ORDERER_ADMIN_PASSWORD}
EOF
}

write_peer_orgs_section() {
  cat <<'EOF'
peerOrgs:
EOF

  local org_index org_zero_based org_name mspid org_domain ca_port anchor_limit peer_index peer_host peer_port
  for ((org_index=1; org_index<=PEER_ORG_COUNT; org_index++)); do
    org_zero_based=$((org_index - 1))
    org_name="org${org_index}"
    mspid="Org${org_index}MSP"
    org_domain="${org_name}.${DOMAIN}"
    ca_port=$(get_peer_ca_port "$org_index")

    cat <<EOF
  - name: ${org_name}
    mspid: ${mspid}
    domain: ${org_domain}
    ca_url: https://localhost:${ca_port}
    ca_name: ca-${org_name}
    ca_tls_cert: organizations/fabric-ca/${org_name}/ca-cert.pem
    peer_count: ${PEERS_PER_ORG}
    anchor_peers:
EOF

    anchor_limit=$ANCHOR_PEERS_PER_ORG
    for ((peer_index=0; peer_index<anchor_limit; peer_index++)); do
      peer_host="${ENV_PREFIX}-peer${peer_index}.${org_domain}"
      peer_port=$(get_peer_port "$org_zero_based" "$peer_index")
      cat <<EOF
      - host: ${peer_host}
        port: ${peer_port}
EOF
    done

    cat <<EOF
    admin_password: ${PEER_ADMIN_PASSWORD}
EOF
  done
}

generate_config() {
  {
    write_network_section
    write_orderer_section
    write_peer_orgs_section
  } > "$OUTPUT_FILE"
}

validate_output() {
  "$YQ_BIN" eval '.' "$OUTPUT_FILE" >/dev/null
}

print_summary() {
  success "已生成配置: $OUTPUT_FILE"
  info "网络名称: $NETWORK_NAME"
  info "环境前缀: $ENV_PREFIX"
  info "Peer 组织数: $PEER_ORG_COUNT"
  info "每组织 Peer 数: $PEERS_PER_ORG"
  info "Orderer 数量: $ORDERER_COUNT"
}

main() {
  parse_args "$@"
  validate_args
  backup_existing_config
  generate_config
  validate_output
  print_summary
}

main "$@"
