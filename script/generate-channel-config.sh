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
cat >> "$CONFIGTX_YAML" <<'EOF'

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

cat >> "$CONFIGTX_YAML" <<'EOF'
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

  ThreeOrgsOrdererGenesis:
    <<: *ChannelDefaults
    Orderer:
      <<: *OrdererDefaults
      Organizations:
        - *OrdererOrg
      Capabilities:
        <<: *OrdererCapabilities
    Consortiums:
      SampleConsortium:
        Organizations:
EOF

# 自动写入所有 Peer 组织到创世块
for org in "${PEER_ORGS[@]}"; do
  echo "          - *${org^}" >> "$CONFIGTX_YAML"
done

# 写入默认单通道 Profile
cat >> "$CONFIGTX_YAML" <<EOF

  ${PRIMARY_CHANNEL_PROFILE}:
    <<: *ChannelDefaults
    Consortium: ${PRIMARY_CHANNEL_CONSORTIUM}
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

for org in "${PEER_ORGS[@]}"; do
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

success "完整 configtx.yaml 已生成！"

# ====================== 生成创世块 + 通道交易 + 锚节点更新 ======================
info "正在生成通道相关文件..."


"$CONFIGTXGEN" -configPath "${PROJECT_ROOT}/config" \
  -profile "$GENESIS_PROFILE" \
  -channelID "$PRIMARY_CHANNEL_NAME" \
  -outputBlock "${CHANNEL_ARTIFACTS}/genesis.block"

"$CONFIGTXGEN" -configPath "${PROJECT_ROOT}/config" \
  -profile "$PRIMARY_CHANNEL_PROFILE" \
  -channelID "$PRIMARY_CHANNEL_NAME" \
  -outputCreateChannelTx "${CHANNEL_ARTIFACTS}/${PRIMARY_CHANNEL_NAME}.tx"


info "所有工作完成！"
success "   configtx.yaml → 完整可用"
success "   创世块 → ${CHANNEL_ARTIFACTS}/genesis.block"
success "   默认通道 → ${PRIMARY_CHANNEL_NAME}"
success "   通道交易 → ${CHANNEL_ARTIFACTS}/${PRIMARY_CHANNEL_NAME}.tx"
info "=================================================="
