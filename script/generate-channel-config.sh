#!/bin/bash
# scripts/generate-channel-config.sh
# 一键生成完整、开箱即用的 configtx.yaml
# 支持：任意组织数量、任意 peer 数量、任意锚节点、任意 orderer 数量
# 自动写入你指定的 ChannelDefaults + 三个常用 Profile

set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"
: "${CONFIGTX_YAML:="${PROJECT_ROOT}/config/configtx.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"

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
  OrdererType: etcdraft
  Addresses:
EOF

# 动态生成 Orderer Addresses
"$YQ_BIN" -r '.ordererOrg.nodes[] | "    - \(.host):\(.port)"' "$CONFIG_FILE" >> "$CONFIGTX_YAML"

cat >> "$CONFIGTX_YAML" <<'EOF'
  BatchTimeout: 2s
  BatchSize:
    MaxMessageCount: 10
    AbsoluteMaxBytes: 99 MB
    PreferredMaxBytes: 512 KB
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

cat >> "$CONFIGTX_YAML" <<EOF
    Options:
      TickInterval: 500ms
      ElectionTick: 10
      HeartbeatTick: 1
      MaxInflightBlocks: 5
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
