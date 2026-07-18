#!/bin/bash
# scripts/generate-peer-org.sh
# 用法：./generate-peer-org.sh org1
# 功能：根据 config/orgs.yaml 完整生成指定 Peer 组织的所有证书（支持 N 个 peer）

set -euo pipefail

# ====================== 自动计算路径======================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"

# ====================== 参数校验 ======================
ORG_NAME="${1:-}"

[[ -n "$ORG_NAME" ]] || { log_error "用法: $0 <org-name>   如: $0 org1"; exit 1; }

# 替换信息输出为颜色化日志
log_info "开始生成 Peer 组织: $ORG_NAME"
log_info "项目根目录: $PROJECT_ROOT"
log_info "配置文件: $CONFIG_FILE"
log_info "=================================================="

# ====================== 读取 orgs.yaml 配置 ======================
ORG_CONFIG=$(load_peer_org_config "$ORG_NAME") || {
  log_error "错误：在 orgs.yaml 中找不到组织 $ORG_NAME"
  exit 1
}

# 使用 yq 提取字段（全部转成 bash 变量）
MSPID=$(echo "$ORG_CONFIG" | yq -r '.mspid')
DOMAIN=$(echo "$ORG_CONFIG" | yq -r '.domain')
CA_URL=$(echo "$ORG_CONFIG" | yq -r '.ca_url')
CA_NAME=$(echo "$ORG_CONFIG" | yq -r '.ca_name')
FABRIC_NET_PREFIX=$(yq -r '.network.env_prefix' "$CONFIG_FILE")

CA_TLS_CERT=$(echo "$ORG_CONFIG" | yq -r '.ca_tls_cert')
[[ "$CA_TLS_CERT" = /* ]] || CA_TLS_CERT="${PROJECT_ROOT}/${CA_TLS_CERT}"

PEER_COUNT=$(echo "$ORG_CONFIG" | yq -r '.peer_count')
ADMIN_PW=$(echo "$ORG_CONFIG" | yq -r '.admin_password // "adminpw"')

# 锚节点（用于后面生成 configtx）
mapfile -t ANCHOR_PEERS < <(
  echo "$ORG_CONFIG" |
  yq -r '.anchor_peers // [] | .[] | "\(.host):\(.port)"'
)

log_info "组织信息:"
log_info "   MSPID        : $MSPID"
log_info "   域名         : $DOMAIN"
log_info "   CA           : $CA_URL ($CA_NAME)"
log_info "   Peer 数量    : $PEER_COUNT"
log_info "   Admin 密码   : $ADMIN_PW"
if [[ ${#ANCHOR_PEERS[@]} -gt 0 ]]; then
  log_info "   锚节点       : ${ANCHOR_PEERS[*]}"
else
  log_info "   锚节点       : 未配置"
fi

# ====================== 路径准备 ======================
ORG_HOME="${PROJECT_ROOT}/organizations/peerOrganizations/${FABRIC_NET_PREFIX}-${DOMAIN}"
ADMIN_MSP_DIR="${ORG_HOME}/users/Admin@${FABRIC_NET_PREFIX}-${DOMAIN}/msp"
ORG_MSP_DIR="${ORG_HOME}/msp"

# 全局 TLS 根证书列表（用于 copy_tls_files 聚合）
ALL_TLS_ROOTS=()
for cert_path in "${PROJECT_ROOT}"/organizations/fabric-ca/*/ca-cert.pem; do
  [[ -f "$cert_path" ]] && ALL_TLS_ROOTS+=("$cert_path")
done

# ====================== 开始干活 ======================
log_info "1. 注册 CA Admin"
enroll_ca_admin "$CA_NAME" "$CA_URL" "$CA_TLS_CERT" "$ORG_HOME" "$ADMIN_PW"
log_info "2. 注册 Admin 用户"
register_identity "$CA_NAME" "$CA_TLS_CERT" "${ORG_NAME}admin" "$ADMIN_PW" "admin" "$ORG_HOME"
enroll_identity_msp "$CA_NAME" "$CA_TLS_CERT" "${ORG_NAME}admin" "$ADMIN_PW" "$ORG_HOME" "$ADMIN_MSP_DIR" "${CA_URL##*:}"

success "Admin 用户注册与 MSP 初始化完成"

log_info "3. 循环生成 $PEER_COUNT 个 Peer 节点"
for ((i=0; i<PEER_COUNT; i++)); do
  PEER_NAME="peer$i"
  PEER_HOST="${FABRIC_NET_PREFIX}-peer${i}.${DOMAIN}"
  PEER_MSP="${ORG_HOME}/peers/${PEER_HOST}/msp"
  PEER_TLS="${ORG_HOME}/peers/${PEER_HOST}/tls"

  log_info "   → [$((i+1))/$PEER_COUNT] 生成 $PEER_HOST"

  # 注册身份
  register_identity "$CA_NAME" "$CA_TLS_CERT" "$PEER_NAME" "${PEER_NAME}pw" "peer" "$ORG_HOME"

  # 注册 MSP
  enroll_identity_msp "$CA_NAME" "$CA_TLS_CERT" "$PEER_NAME" "${PEER_NAME}pw" "$ORG_HOME" "$PEER_MSP" "${CA_URL##*:}"

  # 注册 TLS 证书（带 SAN）
  enroll_identity_tls "$CA_NAME" "$CA_TLS_CERT" "$PEER_NAME" "${PEER_NAME}pw" "$ORG_HOME" "$PEER_TLS" "$PEER_HOST" "${CA_URL##*:}"

  # 聚合所有 CA 根证书到 tls/ca.crt
  copy_tls_files "$PEER_TLS" "${ALL_TLS_ROOTS[@]}"
done

# ====================== 生成组织级 MSP ======================
log_info "4. 生成组织级MSP"
CA_CERT_NAME=$(basename "$(find "${ADMIN_MSP_DIR}/cacerts" -name "*.pem" | head -1)")
TLS_CERT_NAME="tls-$(basename "$CA_TLS_CERT")"
# log_debug "${ORG_MSP_DIR}"
create_organization_msp \
  "$ORG_MSP_DIR" \
  "$ADMIN_MSP_DIR" \
  "$CA_TLS_CERT" \
  "$TLS_CERT_NAME" \
  "$CA_CERT_NAME"

# 复制 config.yaml 到 Admin
copy_msp_config "${ORG_MSP_DIR}/config.yaml" "${ADMIN_MSP_DIR}"

# 复制 config.yaml 到所有 Peer
for ((i=0; i<PEER_COUNT; i++)); do
  PEER_HOST="${FABRIC_NET_PREFIX}-peer${i}.${DOMAIN}"
  PEER_MSP="${ORG_HOME}/peers/${PEER_HOST}/msp"
  copy_msp_config "${ORG_MSP_DIR}/config.yaml" "$PEER_MSP"
done


log_success "组织 $ORG_NAME 证书生成完成！"
log_info "   共生成 Peer 节点: $PEER_COUNT 个"
log_info "   组织 MSP 路径: $ORG_MSP_DIR"
log_info "   所有节点 TLS 已聚合全局根证书"
log_info "=================================================="
