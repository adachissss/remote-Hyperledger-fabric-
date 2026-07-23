#!/bin/bash
# scripts/generate-channel-config.sh
# 一键生成完整、开箱即用的 configtx.yaml
# 支持：任意组织数量、任意 peer 数量、任意锚节点、任意 orderer 数量
# 自动写入你指定的 ChannelDefaults + 三个常用 Profile

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"
: "${CONFIGTX_YAML:="${PROJECT_ROOT}/config/configtx.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"
source "${SCRIPT_DIR}/lib/fabric-version.sh"

CHANNEL_ARTIFACTS="${PROJECT_ROOT}/channel-artifacts"
mkdir -p "$CHANNEL_ARTIFACTS"

debug "正在生成完整可用的 configtx.yaml"
debug "源文件: $CONFIG_FILE"
debug "输出文件: $CONFIGTX_YAML"
info "=================================================="

# ====================== 读取配置 ======================
ORDERER_CONFIG=$(load_orderer_org_config)
ORDERER_MSPID=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.mspid')
ORDERER_DOMAIN=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.domain')
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
GENESIS_PROFILE=$(get_config_value_raw '.profiles.genesis')
PRIMARY_CHANNEL_CONFIG=$(load_primary_channel_config)
PRIMARY_CHANNEL_NAME=$(echo "$PRIMARY_CHANNEL_CONFIG" | "$YQ_BIN" -r '.name')
PRIMARY_CHANNEL_PROFILE=$(echo "$PRIMARY_CHANNEL_CONFIG" | "$YQ_BIN" -r '.profile')
PRIMARY_CHANNEL_CONSORTIUM=$(echo "$PRIMARY_CHANNEL_CONFIG" | "$YQ_BIN" -r '.consortium // "SampleConsortium"')
ORDERER_TYPE=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.consensus_type // "etcdraft"')
BATCH_TIMEOUT_SECONDS=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.batch_timeout_seconds // 2')
BATCH_MAX_MESSAGE_COUNT=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.batch_size.max_message_count // 10')
BATCH_ABSOLUTE_MAX_BYTES_MIB=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.batch_size.absolute_max_bytes_mib // 99')
BATCH_PREFERRED_MAX_BYTES_KIB=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.batch_size.preferred_max_bytes_kib // 512')
ORDERER_NODE_COUNT=$(echo "$ORDERER_CONFIG" | "$YQ_BIN" -r '.nodes | length')
FABRIC_VERSION=$(get_config_value_raw ".network.fabric_version // \"${PLUS_FABRIC_DEFAULT_FABRIC_VERSION}\"")

validate_integer_range() {
  local label="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"

  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < minimum || 10#$value > maximum )); then
    error "${label} 必须是 ${minimum}-${maximum} 之间的整数，当前值为 ${value}"
    exit 1
  fi
}

validate_integer_range "BatchTimeout（秒）" "$BATCH_TIMEOUT_SECONDS" 1 300
validate_integer_range "BatchSize.MaxMessageCount" "$BATCH_MAX_MESSAGE_COUNT" 1 10000
validate_integer_range "BatchSize.AbsoluteMaxBytes（MiB）" "$BATCH_ABSOLUTE_MAX_BYTES_MIB" 1 99
validate_integer_range "BatchSize.PreferredMaxBytes（KiB）" "$BATCH_PREFERRED_MAX_BYTES_KIB" 1 101376

if (( 10#$BATCH_PREFERRED_MAX_BYTES_KIB > 10#$BATCH_ABSOLUTE_MAX_BYTES_MIB * 1024 )); then
  error "BatchSize.PreferredMaxBytes 不能大于 AbsoluteMaxBytes"
  exit 1
fi

case "$ORDERER_TYPE" in
  etcdraft) ;;
  solo)
    [[ "$ORDERER_NODE_COUNT" -eq 1 ]] || {
      error "Solo 共识仅支持一个 Orderer，当前配置为 ${ORDERER_NODE_COUNT} 个"
      exit 1
    }
    [[ "${FABRIC_VERSION%%.*}" -lt 3 ]] || {
      error "Fabric ${FABRIC_VERSION} 不支持 Solo 共识"
      exit 1
    }
    ;;
  *)
    error "不支持的 Orderer 共识类型: $ORDERER_TYPE"
    exit 1
    ;;
esac

mapfile -t PEER_ORGS < <(get_peer_org_names)

# ====================== 生成完整 configtx.yaml ======================
cat > "$CONFIGTX_YAML" <<'EOF'
---
Organizations:
EOF

# 生成所有 Peer 组织
for org in "${PEER_ORGS[@]}"; do
  ORG_CONFIG=$(load_peer_org_config "$org")
  MSPID=$(echo "$ORG_CONFIG" | "$YQ_BIN" -r '.mspid')
  DOMAIN=$(echo "$ORG_CONFIG" | "$YQ_BIN" -r '.domain')

  # 先计算 AnchorPeers 的 YAML 片段（保持正确缩进，host 使用配置中的完整真实主机名）
  ANCHOR_PEERS_YAML="$(
    "$YQ_BIN" -r '
      .anchor_peers // [] | .[] |
      "      - Host: " + .host + "\n        Port: " + (.port|tostring)
    ' <<< "$ORG_CONFIG"
  )"

  cat >> "$CONFIGTX_YAML" <<ORG

  - &${org^}
    Name: ${MSPID}
    ID: ${MSPID}
    MSPDir: ../organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${DOMAIN}/msp
    Policies:
      Readers:
        Type: Signature
        Rule: "OR('${MSPID}.member')"
      Writers:
        Type: Signature
        Rule: "OR('${MSPID}.member')"
      Admins:
        Type: Signature
        Rule: "OR('${MSPID}.admin')"
      Endorsement:
        Type: Signature
        Rule: "OR('${MSPID}.peer')"
    AnchorPeers:
$( if [[ -n "$ANCHOR_PEERS_YAML" ]]; then echo "$ANCHOR_PEERS_YAML"; else echo "      []"; fi )
ORG
done

# 生成 OrdererOrg
cat >> "$CONFIGTX_YAML" <<ORDERER

  - &OrdererOrg
    Name: ${ORDERER_MSPID}
    ID: ${ORDERER_MSPID}
    MSPDir: ../organizations/ordererOrganizations/${ORDERER_DOMAIN}/msp
    Policies:
      Readers:
        Type: Signature
        Rule: "OR('${ORDERER_MSPID}.member')"
      Writers:
        Type: Signature
        Rule: "OR('${ORDERER_MSPID}.member')"
      Admins:
        Type: Signature
        Rule: "OR('${ORDERER_MSPID}.admin')"
ORDERER

# 固定写入 Capabilities + ApplicationDefaults + OrdererDefaults
cat >> "$CONFIGTX_YAML" <<EOF

Capabilities:
  Channel: &ChannelCapabilities
    V2_0: true
  Orderer: &OrdererCapabilities
    V2_0: true
  Application: &ApplicationCapabilities
    V2_0: true

Application: &ApplicationDefaults
  Organizations: []
  Policies:
    Readers:
      Type: ImplicitMeta
      Rule: "ANY Readers"
    Writers:
      Type: ImplicitMeta
      Rule: "ANY Writers"
    Admins:
      Type: ImplicitMeta
      Rule: "MAJORITY Admins"
    LifecycleEndorsement:
      Type: ImplicitMeta
      Rule: "MAJORITY Endorsement"
    Endorsement:
      Type: ImplicitMeta
      Rule: "MAJORITY Endorsement"
  Capabilities:
    <<: *ApplicationCapabilities

Orderer: &OrdererDefaults
  OrdererType: ${ORDERER_TYPE}
  Addresses:
EOF

# 动态生成 Orderer Addresses
"$YQ_BIN" -r '.ordererOrg.nodes[] | "    - \(.host):\(.port)"' "$CONFIG_FILE" >> "$CONFIGTX_YAML"

cat >> "$CONFIGTX_YAML" <<EOF
  BatchTimeout: ${BATCH_TIMEOUT_SECONDS}s
  BatchSize:
    MaxMessageCount: ${BATCH_MAX_MESSAGE_COUNT}
    AbsoluteMaxBytes: ${BATCH_ABSOLUTE_MAX_BYTES_MIB} MB
    PreferredMaxBytes: ${BATCH_PREFERRED_MAX_BYTES_KIB} KB
EOF

if [[ "$ORDERER_TYPE" == "etcdraft" ]]; then
  cat >> "$CONFIGTX_YAML" <<'EOF'
  EtcdRaft:
    Consenters:
EOF

  # 动态生成 Consenters
  export domain="$ORDERER_DOMAIN"

  "$YQ_BIN" -r '
    .ordererOrg.nodes[] |
    "      - Host: " + .host + "\n" +
    "        Port: " + (.port|tostring) + "\n" +
    "        ClientTLSCert: ../organizations/ordererOrganizations/" + env(domain) + "/orderers/" + .host + "/tls/server.crt\n" +
    "        ServerTLSCert: ../organizations/ordererOrganizations/" + env(domain) + "/orderers/" + .host + "/tls/server.crt"
  ' "$CONFIG_FILE" >> "$CONFIGTX_YAML"

  cat >> "$CONFIGTX_YAML" <<'EOF'
    Options:
      TickInterval: 500ms
      ElectionTick: 10
      HeartbeatTick: 1
      MaxInflightBlocks: 5
EOF
fi

cat >> "$CONFIGTX_YAML" <<'EOF'
  Organizations: []
  Policies:
    Readers:
      Type: ImplicitMeta
      Rule: "ANY Readers"
    Writers:
      Type: ImplicitMeta
      Rule: "ANY Writers"
    Admins:
      Type: ImplicitMeta
      Rule: "MAJORITY Admins"
    BlockValidation:
      Type: ImplicitMeta
      Rule: "ANY Writers"
  Capabilities:
    <<: *OrdererCapabilities

Channel: &ChannelDefaults
  Policies:
    Readers:
      Type: ImplicitMeta
      Rule: "ANY Readers"
    Writers:
      Type: ImplicitMeta
      Rule: "ANY Writers"
    Admins:
      Type: ImplicitMeta
      Rule: "MAJORITY Admins"
  Capabilities:
    <<: *ChannelCapabilities

Profiles:

  ${GENESIS_PROFILE}:
    <<: *ChannelDefaults
    Orderer:
      <<: *OrdererDefaults
      Organizations:
        - *OrdererOrg
      Capabilities:
        <<: *OrdererCapabilities
EOF

mapfile -t CONSORTIUMS < <(
  get_config_value_raw '.channels[] | (.consortium // "SampleConsortium")' | awk 'NF && !seen[$0]++'
)
echo "    Consortiums:" >> "$CONFIGTX_YAML"
for consortium in "${CONSORTIUMS[@]}"; do
  echo "      ${consortium}:" >> "$CONFIGTX_YAML"
  echo "        Organizations:" >> "$CONFIGTX_YAML"
  for org in "${PEER_ORGS[@]}"; do
    echo "          - *${org^}" >> "$CONFIGTX_YAML"
  done
done

mapfile -t CHANNEL_NAMES < <(get_channel_names)
for channel_name in "${CHANNEL_NAMES[@]}"; do
  channel_profile=$(get_channel_profile "$channel_name")
  channel_consortium=$(get_channel_consortium "$channel_name")
  mapfile -t channel_members < <(get_channel_member_orgs "$channel_name")

  cat >> "$CONFIGTX_YAML" <<EOF

  ${channel_profile}:
    <<: *ChannelDefaults
    Consortium: ${channel_consortium}
    Orderer:
      <<: *OrdererDefaults
      Organizations:
        - *OrdererOrg
      Capabilities:
        <<: *OrdererCapabilities
    Application:
      <<: *ApplicationDefaults
      Organizations:
EOF

  for org in "${channel_members[@]}"; do
    echo "        - *${org^}" >> "$CONFIGTX_YAML"
  done

  cat >> "$CONFIGTX_YAML" <<'EOF'
      Policies:
        Readers:
          Type: ImplicitMeta
          Rule: "ANY Readers"
        Writers:
          Type: ImplicitMeta
          Rule: "ANY Writers"
        Admins:
          Type: ImplicitMeta
          Rule: "MAJORITY Admins"
        Endorsement:
          Type: ImplicitMeta
          Rule: "ANY Endorsement"
      Capabilities:
        <<: *ApplicationCapabilities
EOF
done

success "完整 configtx.yaml 已生成！"

# ====================== 生成所有通道配置块和交易文件 ======================
info "正在生成通道相关文件..."

for channel_name in "${CHANNEL_NAMES[@]}"; do
  channel_profile=$(get_channel_profile "$channel_name")
  "$CONFIGTXGEN" -configPath "${PROJECT_ROOT}/config" \
    -profile "$channel_profile" \
    -channelID "$channel_name" \
    -outputBlock "${CHANNEL_ARTIFACTS}/${channel_name}.block"
  "$CONFIGTXGEN" -configPath "${PROJECT_ROOT}/config" \
    -profile "$channel_profile" \
    -channelID "$channel_name" \
    -outputCreateChannelTx "${CHANNEL_ARTIFACTS}/${channel_name}.tx"
done

cp "${CHANNEL_ARTIFACTS}/${PRIMARY_CHANNEL_NAME}.block" "${CHANNEL_ARTIFACTS}/genesis.block"

info "所有工作完成！"
success "   configtx.yaml → 完整可用"
success "   通道数量 → ${#CHANNEL_NAMES[@]}"
success "   主通道兼容块 → ${CHANNEL_ARTIFACTS}/genesis.block"
info "=================================================="
