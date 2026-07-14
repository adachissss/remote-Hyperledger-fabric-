#!/bin/bash
set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
else
  SCRIPT_DIR="${PROJECT_ROOT}/script"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"

PORT_SLOT_STRIDE=10
PORT_ORG_STRIDE=100
PORT_BASE_START=7000
CA_INTERNAL_PORT=7054
CA_PORT_BASE_START=7000
CA_PORT_STRIDE=1000
CA_PORT_OFFSET=54
ORDERER_OPERATIONS_PORT_BASE=9443
HOST_PORT_OFFSET=$(get_config_value_raw '.network.network_port__start // 0')
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
PRIMARY_CHANNEL_NAME=$(get_primary_channel_name)
ORDERER_ORG_MSPID=$(get_config_value_raw '.ordererOrg.mspid')
ORDERER_ORG_DOMAIN=$(get_config_value_raw '.ordererOrg.domain')

get_peer_component_offset() {
  case "${1:-peer}" in
    peer) echo 51 ;;
    chaincode) echo 52 ;;
    metrics) echo 55 ;;
    *) log_error "未知组件: $1"; exit 1 ;;
  esac
}

get_peer_port_override() {
  local org_name="$1"
  local peer_index="$2"
  local component="$3"
  local field

  case "$component" in
    peer) field='peer_port' ;;
    chaincode) field='chaincode_port' ;;
    metrics) field='metrics_port' ;;
    *) log_error "未知组件: $component"; exit 1 ;;
  esac

  "$YQ_BIN" -r ".peerOrgs[] | select(.name == \"${org_name}\") | .peers[${peer_index}].${field} // empty" "$CONFIG_FILE"
}

get_peer_port() {
  local org_name="$1"
  local peer_index="$2"
  local component="${3:-peer}"
  local override

  override=$(get_peer_port_override "$org_name" "$peer_index" "$component")
  if [[ -n "$override" && "$override" != "null" ]]; then
    echo "$override"
    return 0
  fi

  local org_index
  local component_offset
  org_index=$(get_peer_org_index "$org_name")
  component_offset=$(get_peer_component_offset "$component")
  echo $((PORT_BASE_START + org_index * PORT_ORG_STRIDE + peer_index * PORT_SLOT_STRIDE + component_offset))
}

extract_port_from_url() {
  local url="$1"
  if [[ "$url" =~ :([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

get_peer_ca_host_port() {
  local org_index="$1"
  local explicit_port="$2"
  local ca_url="$3"

  if [[ -n "$explicit_port" && "$explicit_port" != "null" ]]; then
    echo "$explicit_port"
    return 0
  fi

  if [[ -n "$ca_url" ]] && extract_port_from_url "$ca_url" >/dev/null; then
    extract_port_from_url "$ca_url"
    return 0
  fi

  echo $((CA_PORT_BASE_START + org_index * CA_PORT_STRIDE + CA_PORT_OFFSET))
}

get_orderer_ca_host_port() {
  local explicit_port="$1"
  local ca_url="$2"
  local peer_org_count="$3"

  if [[ -n "$explicit_port" && "$explicit_port" != "null" ]]; then
    echo "$explicit_port"
    return 0
  fi

  if [[ -n "$ca_url" ]] && extract_port_from_url "$ca_url" >/dev/null; then
    extract_port_from_url "$ca_url"
    return 0
  fi

  echo $((CA_PORT_BASE_START + peer_org_count * CA_PORT_STRIDE + CA_PORT_OFFSET))
}

get_orderer_admin_port() {
  local orderer_port="$1"
  local explicit_admin_port="$2"
  if [[ -n "$explicit_admin_port" && "$explicit_admin_port" != "null" ]]; then
    echo "$explicit_admin_port"
  else
    echo $((orderer_port + 3))
  fi
}

get_orderer_ops_port() {
  local orderer_index="$1"
  local explicit_ops_port="$2"
  if [[ -n "$explicit_ops_port" && "$explicit_ops_port" != "null" ]]; then
    echo "$explicit_ops_port"
  else
    echo $((ORDERER_OPERATIONS_PORT_BASE + orderer_index))
  fi
}

docker_container_json() {
  local container_name="$1"

  if ! command -v docker >/dev/null 2>&1; then
    jq -nc --arg name "$container_name" '{name:$name, exists:false, running:false, status:null}'
    return 0
  fi

  if ! docker inspect "$container_name" >/dev/null 2>&1; then
    jq -nc --arg name "$container_name" '{name:$name, exists:false, running:false, status:null}'
    return 0
  fi

  local status running image started_at
  status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)
  running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  image=$(docker inspect --format '{{.Config.Image}}' "$container_name" 2>/dev/null || true)
  started_at=$(docker inspect --format '{{.State.StartedAt}}' "$container_name" 2>/dev/null || true)

  jq -nc \
    --arg name "$container_name" \
    --arg status "${status:-}" \
    --arg image "${image:-}" \
    --arg startedAt "${started_at:-}" \
    --argjson running "${running:-false}" \
    '{name:$name, exists:true, running:$running, status:($status|select(length>0)), image:($image|select(length>0)), startedAt:($startedAt|select(length>0))}'
}

build_peer_orgs_json() {
  local peer_orgs_file
  peer_orgs_file=$(mktemp)

  mapfile -t PEER_ORGS < <(get_peer_org_names)
  for org in "${PEER_ORGS[@]}"; do
    local org_config mspid domain peer_count org_index peers_file peers_json anchor_file anchor_json
    org_config=$(load_peer_org_config "$org")
    mspid=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.mspid')
    domain=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.domain')
    peer_count=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.peer_count')
    org_index=$(get_peer_org_index "$org")

    peers_file=$(mktemp)
    for ((i=0; i<peer_count; i++)); do
      local peer_name peer_host peer_port chaincode_port metrics_port host_peer_port host_metrics_port
      local container_json
      peer_name="peer${i}"
      peer_host="${FABRIC_NET_PREFIX}-${peer_name}.${domain}"
      peer_port=$(get_peer_port "$org" "$i" peer)
      chaincode_port=$(get_peer_port "$org" "$i" chaincode)
      metrics_port=$(get_peer_port "$org" "$i" metrics)
      host_peer_port=$((HOST_PORT_OFFSET + peer_port))
      host_metrics_port=$((HOST_PORT_OFFSET + metrics_port))
      container_json=$(docker_container_json "$peer_host")

      jq -nc \
        --arg org "$org" \
        --arg name "$peer_name" \
        --arg host "$peer_host" \
        --arg domain "$domain" \
        --arg mspid "$mspid" \
        --argjson peerPort "$peer_port" \
        --argjson hostPeerPort "$host_peer_port" \
        --argjson chaincodePort "$chaincode_port" \
        --argjson metricsPort "$metrics_port" \
        --argjson hostMetricsPort "$host_metrics_port" \
        --argjson container "$container_json" \
        '{org:$org,name:$name,host:$host,domain:$domain,mspid:$mspid,ports:{peer:$peerPort,hostPeer:$hostPeerPort,chaincode:$chaincodePort,metrics:$metricsPort,hostMetrics:$hostMetricsPort},container:$container}' >> "$peers_file"
    done
    peers_json=$(jq -s '.' "$peers_file")
    rm -f "$peers_file"

    anchor_file=$(mktemp)
    mapfile -t ANCHORS < <("$YQ_BIN" -r ".peerOrgs[] | select(.name == \"${org}\") | .anchor_peers[]? | (.host + \"|\" + (.port|tostring))" "$CONFIG_FILE")
    for anchor in "${ANCHORS[@]:-}"; do
      [[ -z "$anchor" ]] && continue
      local anchor_host anchor_port
      IFS='|' read -r anchor_host anchor_port <<< "$anchor"
      jq -nc --arg host "$anchor_host" --argjson port "$anchor_port" '{host:$host,port:$port}' >> "$anchor_file"
    done
    anchor_json=$(jq -s '.' "$anchor_file")
    rm -f "$anchor_file"

    jq -nc \
      --arg name "$org" \
      --arg mspid "$mspid" \
      --arg domain "$domain" \
      --argjson orgIndex "$org_index" \
      --argjson peerCount "$peer_count" \
      --argjson peers "$peers_json" \
      --argjson anchorPeers "$anchor_json" \
      '{name:$name,mspid:$mspid,domain:$domain,orgIndex:$orgIndex,peerCount:$peerCount,anchorPeers:$anchorPeers,peers:$peers}' >> "$peer_orgs_file"
  done

  jq -s '.' "$peer_orgs_file"
  rm -f "$peer_orgs_file"
}

build_orderers_json() {
  local orderers_file
  orderers_file=$(mktemp)

  local orderer_config mspid domain
  orderer_config=$(load_orderer_org_config)
  mspid=$(printf '%s' "$orderer_config" | "$YQ_BIN" -r '.mspid')
  domain=$(printf '%s' "$orderer_config" | "$YQ_BIN" -r '.domain')

  mapfile -t ORDERER_NODES < <(printf '%s' "$orderer_config" | "$YQ_BIN" -r '.nodes[] | "\(.name // .host)|\(.host)|\(.port)|\(.admin_port // "")|\(.operations_port // "")"')
  local idx=0
  for node_line in "${ORDERER_NODES[@]}"; do
    local name host port admin_override ops_override admin_port ops_port container_json
    IFS='|' read -r name host port admin_override ops_override <<< "$node_line"
    admin_port=$(get_orderer_admin_port "$port" "$admin_override")
    ops_port=$(get_orderer_ops_port "$idx" "$ops_override")
    container_json=$(docker_container_json "$host")

    jq -nc \
      --arg name "$name" \
      --arg host "$host" \
      --arg domain "$domain" \
      --arg mspid "$mspid" \
      --argjson ordererPort "$port" \
      --argjson adminPort "$admin_port" \
      --argjson operationsPort "$ops_port" \
      --argjson container "$container_json" \
      '{name:$name,host:$host,domain:$domain,mspid:$mspid,ports:{orderer:$ordererPort,admin:$adminPort,operations:$operationsPort},container:$container}' >> "$orderers_file"
    idx=$((idx + 1))
  done

  jq -s '.' "$orderers_file"
  rm -f "$orderers_file"
}

build_cas_json() {
  local peer_ca_file
  peer_ca_file=$(mktemp)

  mapfile -t PEER_ORGS < <(get_peer_org_names)
  for org in "${PEER_ORGS[@]}"; do
    local org_config org_index ca_name ca_url ca_port_override host_port container_json
    org_config=$(load_peer_org_config "$org")
    org_index=$(get_peer_org_index "$org")
    ca_name=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.ca_name')
    ca_url=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.ca_url // empty')
    ca_port_override=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.ca_port // empty')
    host_port=$(get_peer_ca_host_port "$org_index" "$ca_port_override" "$ca_url")
    container_json=$(docker_container_json "ca_${org}")

    jq -nc \
      --arg org "$org" \
      --arg serviceName "ca_${org}" \
      --arg caName "$ca_name" \
      --arg url "$ca_url" \
      --argjson hostPort "$host_port" \
      --argjson internalPort "$CA_INTERNAL_PORT" \
      --argjson container "$container_json" \
      '{org:$org,serviceName:$serviceName,caName:$caName,url:($url|select(length>0)),ports:{host:$hostPort,internal:$internalPort},container:$container}' >> "$peer_ca_file"
  done
  local peer_ca_json
  peer_ca_json=$(jq -s '.' "$peer_ca_file")
  rm -f "$peer_ca_file"

  local orderer_config orderer_ca_name orderer_ca_url orderer_ca_port_override orderer_ca_host_port orderer_container_json
  orderer_config=$(load_orderer_org_config)
  orderer_ca_name=$(printf '%s' "$orderer_config" | "$YQ_BIN" -r '.ca_name')
  orderer_ca_url=$(printf '%s' "$orderer_config" | "$YQ_BIN" -r '.ca_url // empty')
  orderer_ca_port_override=$(printf '%s' "$orderer_config" | "$YQ_BIN" -r '.ca_port // empty')
  orderer_ca_host_port=$(get_orderer_ca_host_port "$orderer_ca_port_override" "$orderer_ca_url" "${#PEER_ORGS[@]}")
  orderer_container_json=$(docker_container_json 'ca_orderer')

  jq -nc \
    --argjson peerOrgs "$peer_ca_json" \
    --arg caName "$orderer_ca_name" \
    --arg url "$orderer_ca_url" \
    --argjson hostPort "$orderer_ca_host_port" \
    --argjson internalPort "$CA_INTERNAL_PORT" \
    --argjson container "$orderer_container_json" \
    '{peerOrgs:$peerOrgs,orderer:{serviceName:"ca_orderer",caName:$caName,url:($url|select(length>0)),ports:{host:$hostPort,internal:$internalPort},container:$container}}'
}

build_channels_json() {
  local channels_file
  channels_file=$(mktemp)

  mapfile -t CHANNELS < <(get_channel_names)
  for channel in "${CHANNELS[@]}"; do
    local profile consortium member_file member_json tx_path block_path
    profile=$(get_channel_profile "$channel")
    consortium=$(get_channel_consortium "$channel")
    tx_path="${PROJECT_ROOT}/channel-artifacts/${channel}.tx"
    block_path="${PROJECT_ROOT}/channel-artifacts/${channel}.block"

    member_file=$(mktemp)
    mapfile -t MEMBER_ORGS < <(get_channel_member_orgs "$channel")
    for member in "${MEMBER_ORGS[@]}"; do
      jq -nc --arg value "$member" '$value' >> "$member_file"
    done
    member_json=$(jq -s '.' "$member_file")
    rm -f "$member_file"

    jq -nc \
      --arg name "$channel" \
      --arg profile "$profile" \
      --arg consortium "$consortium" \
      --argjson memberOrgs "$member_json" \
      --arg txPath "$tx_path" \
      --arg blockPath "$block_path" \
      --argjson txExists "$([[ -f "$tx_path" ]] && echo true || echo false)" \
      --argjson blockExists "$([[ -f "$block_path" ]] && echo true || echo false)" \
      --argjson isPrimary "$([[ "$channel" == "$PRIMARY_CHANNEL_NAME" ]] && echo true || echo false)" \
      '{name:$name,profile:$profile,consortium:($consortium|select(length>0)),isPrimary:$isPrimary,memberOrgs:$memberOrgs,artifacts:{tx:{path:$txPath,exists:$txExists},block:{path:$blockPath,exists:$blockExists}}}' >> "$channels_file"
  done

  jq -s '.' "$channels_file"
  rm -f "$channels_file"
}

PEER_ORGS_JSON=$(build_peer_orgs_json)
ORDERERS_JSON=$(build_orderers_json)
CAS_JSON=$(build_cas_json)
CHANNELS_JSON=$(build_channels_json)

ORDERER_COUNT=$(jq 'length' <<< "$ORDERERS_JSON")
PEER_ORG_COUNT=$(jq 'length' <<< "$PEER_ORGS_JSON")
PEER_COUNT=$(jq '[.[].peerCount] | add // 0' <<< "$PEER_ORGS_JSON")
CHANNEL_COUNT=$(jq 'length' <<< "$CHANNELS_JSON")

jq -n \
  --arg generatedAt "$(date -Iseconds)" \
  --arg configFile "$CONFIG_FILE" \
  --arg configSource "${CONFIG_SOURCE:-legacy}" \
  --arg primaryChannel "$PRIMARY_CHANNEL_NAME" \
  --arg networkId "$(get_config_value_raw '.network.id // empty')" \
  --arg networkName "$(get_config_value_raw '.network.name')" \
  --arg networkDomain "$(get_config_value_raw '.network.domain')" \
  --arg envPrefix "$FABRIC_NET_PREFIX" \
  --arg ordererOrgMspid "$ORDERER_ORG_MSPID" \
  --arg ordererOrgDomain "$ORDERER_ORG_DOMAIN" \
  --argjson tlsEnabled "$([[ "$(get_config_value_raw '.network.tls_enabled // true')" == "true" ]] && echo true || echo false)" \
  --argjson hostPortOffset "$HOST_PORT_OFFSET" \
  --argjson summary "$(jq -nc --argjson peerOrgCount "$PEER_ORG_COUNT" --argjson peerCount "$PEER_COUNT" --argjson ordererCount "$ORDERER_COUNT" --argjson channelCount "$CHANNEL_COUNT" '{peerOrgCount:$peerOrgCount,peerCount:$peerCount,ordererCount:$ordererCount,channelCount:$channelCount}')" \
  --argjson peerOrgs "$PEER_ORGS_JSON" \
  --argjson orderers "$ORDERERS_JSON" \
  --argjson cas "$CAS_JSON" \
  --argjson channels "$CHANNELS_JSON" \
  '{
    generatedAt: $generatedAt,
    config: {
      file: $configFile,
      source: $configSource
    },
    network: {
      id: ($networkId | select(length > 0)),
      name: $networkName,
      domain: $networkDomain,
      envPrefix: $envPrefix,
      tlsEnabled: $tlsEnabled,
      hostPortOffset: $hostPortOffset,
      primaryChannel: $primaryChannel
    },
    summary: $summary,
    ordererOrg: {
      mspid: $ordererOrgMspid,
      domain: $ordererOrgDomain
    },
    peerOrgs: $peerOrgs,
    orderers: $orderers,
    cas: $cas,
    channels: $channels
  }'
