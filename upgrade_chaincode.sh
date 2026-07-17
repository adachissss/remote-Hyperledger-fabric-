#!/bin/bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
用法: ./upgrade_chaincode.sh -n <链码名> -v <版本> -s <序列> -c <通道> [选项]

示例:
  ./upgrade_chaincode.sh -n erc20 -v 1.0 -s 1 -c mychannel
  ./upgrade_chaincode.sh -n rsdata -v 1.0.1 -s 2 -c mychannel --collections-config ./chaincode/collections_config.json
  ./upgrade_chaincode.sh rsdata 1.0.1 2 mychannel

选项:
  -p, --path <目录>                 指定链码目录。默认优先 ./chaincode/<链码名>，其次 ./chaincode/<链码名>-v<版本>
  --lang <node|golang|java>         链码语言；默认 node
  --collections-config <文件>       指定 private data collection 配置文件；不传则不使用
  --signature-policy <策略>         指定背书策略；默认按 config/orgs.yaml 中组织生成 OutOf(N,...)
  -h, --help                        显示帮助
EOF
}

CHAINCODE_NAME="${CHAINCODE_NAME:-}"
CHANNEL_NAME="${CHANNEL_NAME:-}"
VERSION=""
SEQUENCE=""
CHAINCODE_DIR=""
COLLECTIONS_CONFIG=""
SIGNATURE_POLICY=""
CHAINCODE_LANG="${CHAINCODE_LANG:-node}"

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--name)
      CHAINCODE_NAME="$2"; shift 2;;
    -c|--channel)
      CHANNEL_NAME="$2"; shift 2;;
    -v|--version)
      VERSION="$2"; shift 2;;
    -s|--sequence)
      SEQUENCE="$2"; shift 2;;
    -p|--path)
      CHAINCODE_DIR="$2"; shift 2;;
    --collections-config)
      COLLECTIONS_CONFIG="$2"; shift 2;;
    --signature-policy)
      SIGNATURE_POLICY="$2"; shift 2;;
    --lang)
      CHAINCODE_LANG="$2"; shift 2;;
    -h|--help)
      print_usage; exit 0;;
    *)
      POSITIONAL+=("$1"); shift;;
  esac
done

if [[ ${#POSITIONAL[@]} -ge 4 ]]; then
  CHAINCODE_NAME="${CHAINCODE_NAME:-${POSITIONAL[0]}}"
  VERSION="${VERSION:-${POSITIONAL[1]}}"
  SEQUENCE="${SEQUENCE:-${POSITIONAL[2]}}"
  CHANNEL_NAME="${CHANNEL_NAME:-${POSITIONAL[3]}}"
elif [[ ${#POSITIONAL[@]} -ge 2 ]]; then
  VERSION="${VERSION:-${POSITIONAL[0]}}"
  SEQUENCE="${SEQUENCE:-${POSITIONAL[1]}}"
fi

if [[ -z "$CHAINCODE_NAME" ]]; then
  echo "错误：未提供链码名。请使用 -n/--name 或设置 CHAINCODE_NAME。"
  print_usage; exit 1
fi
if [[ -z "$VERSION" || -z "$SEQUENCE" ]]; then
  echo "错误：版本与序列必须提供。"
  print_usage; exit 1
fi
if [[ -z "$CHANNEL_NAME" ]]; then
  echo "错误：未提供通道名。请使用 -c/--channel 或设置 CHANNEL_NAME。"
  print_usage; exit 1
fi
if [[ "$CHAINCODE_LANG" != "node" && "$CHAINCODE_LANG" != "golang" && "$CHAINCODE_LANG" != "java" ]]; then
  echo "错误：链码语言必须是 node、golang 或 java。"
  exit 1
fi

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$SCRIPT_DIR"
fi
cd "$PROJECT_ROOT"

: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

if [[ ! -f "./script/setGlobals.sh" ]]; then
  error "未找到 setGlobals.sh，请确认脚本在 Fabric 项目根目录执行"
  exit 1
fi
source ./script/setGlobals.sh

export PATH="${PROJECT_ROOT}/bin:$PATH"
export CORE_PEER_TLS_ENABLED=true

FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
ORDERER_HOST_OVERRIDE=$(get_config_value_raw '.ordererOrg.nodes[0].host')
ORDERER_PORT=$(get_config_value_raw '.ordererOrg.nodes[0].port')
ORDERER_DOMAIN=$(get_config_value_raw '.ordererOrg.domain // .network.domain')
ORDERER_ADDRESS="${ORDERER_HOST_OVERRIDE}:${ORDERER_PORT}"
ORDERER_CA="${PROJECT_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/${ORDERER_HOST_OVERRIDE}/tls/ca.crt"

if [[ -z "$CHAINCODE_DIR" ]]; then
  if [[ -d "./chaincode/${CHAINCODE_NAME}" ]]; then
    CHAINCODE_DIR="./chaincode/${CHAINCODE_NAME}"
  elif [[ -d "./chaincode/${CHAINCODE_NAME}-v${VERSION}" ]]; then
    CHAINCODE_DIR="./chaincode/${CHAINCODE_NAME}-v${VERSION}"
  else
    CHAINCODE_DIR="./chaincode/${CHAINCODE_NAME}"
  fi
fi

if [[ ! -d "$CHAINCODE_DIR" ]]; then
  error "链码目录不存在: $CHAINCODE_DIR"
  exit 1
fi
if [[ -n "$COLLECTIONS_CONFIG" && ! -f "$COLLECTIONS_CONFIG" ]]; then
  error "collections 配置文件不存在: $COLLECTIONS_CONFIG"
  exit 1
fi
if [[ ! -f "$ORDERER_CA" ]]; then
  error "Orderer TLS CA 不存在: $ORDERER_CA"
  exit 1
fi

mapfile -t ORGS < <(get_peer_org_names)
if [[ ${#ORGS[@]} -eq 0 ]]; then
  error "未在 ${CONFIG_FILE} 中读取到 peerOrgs"
  exit 1
fi

if [[ -z "$SIGNATURE_POLICY" ]]; then
  POLICY_MEMBERS=()
  for ORG in "${ORGS[@]}"; do
    MSP_ID=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .mspid")
    POLICY_MEMBERS+=("'${MSP_ID}.member'")
  done
  REQUIRED=$(( (${#ORGS[@]} / 2) + 1 ))
  SIGNATURE_POLICY="OutOf(${REQUIRED}, $(IFS=', '; echo "${POLICY_MEMBERS[*]}"))"
fi

PKG_FILE="${CHAINCODE_NAME}_${VERSION}.tar.gz"
LABEL="${CHAINCODE_NAME}_${VERSION}"

info "链码目录: $CHAINCODE_DIR"
info "通道: $CHANNEL_NAME"
info "链码语言: $CHAINCODE_LANG"
info "组织: ${ORGS[*]}"
info "背书策略: $SIGNATURE_POLICY"
if [[ -n "$COLLECTIONS_CONFIG" ]]; then
  info "collections 配置: $COLLECTIONS_CONFIG"
else
  info "collections 配置: 未使用"
fi

PACKAGE_ARGS=(peer lifecycle chaincode package "$PKG_FILE" --path "$CHAINCODE_DIR" --lang "$CHAINCODE_LANG" --label "$LABEL")
info "正在打包链码..."
printf '执行命令: %q ' "${PACKAGE_ARGS[@]}"; printf '\n'
"${PACKAGE_ARGS[@]}"
success "链码已打包为 $PKG_FILE"

APPROVE_EXTRA_ARGS=()
COMMIT_EXTRA_ARGS=()
if [[ -n "$COLLECTIONS_CONFIG" ]]; then
  APPROVE_EXTRA_ARGS+=(--collections-config "$COLLECTIONS_CONFIG")
  COMMIT_EXTRA_ARGS+=(--collections-config "$COLLECTIONS_CONFIG")
fi

PEER_CONN_ARGS=()
LAST_ORG=""
for ORG in "${ORGS[@]}"; do
  echo "-------------------------------------------"
  echo "切换到 $ORG 身份"
  setGlobals "$ORG"

  echo "安装链码到 $ORG ..."
  peer lifecycle chaincode install "$PKG_FILE" || echo "链码可能已安装，继续执行"

  echo "获取 package ID ..."
  PKG_ID=$(peer lifecycle chaincode queryinstalled | grep "$LABEL" | sed -n 's/^Package ID: //; s/, Label:.*$//p')
  if [[ -z "$PKG_ID" ]]; then
    echo "未找到 package ID，请检查安装是否成功"
    exit 1
  fi
  echo "Package ID: $PKG_ID"

  echo "批准链码定义..."
  peer lifecycle chaincode approveformyorg \
    -o "$ORDERER_ADDRESS" \
    --ordererTLSHostnameOverride "$ORDERER_HOST_OVERRIDE" \
    --signature-policy "$SIGNATURE_POLICY" \
    --tls \
    --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL_NAME" \
    --name "$CHAINCODE_NAME" \
    --version "$VERSION" \
    --package-id "$PKG_ID" \
    --sequence "$SEQUENCE" \
    "${APPROVE_EXTRA_ARGS[@]}"

  echo "$ORG 批准成功"

  PEER_HOST=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .anchor_peers[0].host")
  PEER_PORT=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${ORG}\") | .anchor_peers[0].port")
  PEER_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
  PEER_CONN_ARGS+=(--peerAddresses "${PEER_HOST}:${PEER_PORT}" --tlsRootCertFiles "$PEER_TLS")
  LAST_ORG="$ORG"
done

echo "-------------------------------------------"
echo "检查链码提交就绪状态..."
setGlobals "$LAST_ORG"
peer lifecycle chaincode checkcommitreadiness \
  --channelID "$CHANNEL_NAME" \
  --name "$CHAINCODE_NAME" \
  --version "$VERSION" \
  --sequence "$SEQUENCE" \
  --signature-policy "$SIGNATURE_POLICY" \
  --output json \
  "${COMMIT_EXTRA_ARGS[@]}"

echo "-------------------------------------------"
echo "提交链码定义（$LAST_ORG 执行）"
peer lifecycle chaincode commit \
  -o "$ORDERER_ADDRESS" \
  --ordererTLSHostnameOverride "$ORDERER_HOST_OVERRIDE" \
  --signature-policy "$SIGNATURE_POLICY" \
  --tls \
  --cafile "$ORDERER_CA" \
  --channelID "$CHANNEL_NAME" \
  --name "$CHAINCODE_NAME" \
  --version "$VERSION" \
  --sequence "$SEQUENCE" \
  "${COMMIT_EXTRA_ARGS[@]}" \
  "${PEER_CONN_ARGS[@]}"

success "链码 ${CHAINCODE_NAME} ${VERSION} (序列 ${SEQUENCE}) 成功提交并生效"
