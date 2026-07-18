#!/bin/bash
# scripts/generate-orderer-certs.sh
# 用法：./generate-orderer-certs.sh
# 功能：根据 config/orgs.yaml 生成完整的 Orderer 组织（支持 N 个 orderer 节点）

set -euo pipefail

# ====================== 自动计算路径（和 peer 脚本完全一致） ======================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"

info "开始生成 Orderer 组织证书"
debug "项目根目录: $PROJECT_ROOT"
debug "配置文件: $CONFIG_FILE"
info "=================================================="

# ====================== 读取 orgs.yaml 中的 Orderer 配置 ======================
ORDERER_CONFIG=$(load_orderer_org_config) || {
  error "错误：orgs.yaml 中未找到 ordererOrg 配置"
  exit 1
}

MSPID=$(echo "$ORDERER_CONFIG" | yq -r '.mspid')
DOMAIN=$(echo "$ORDERER_CONFIG" | yq -r '.domain')
CA_URL=$(echo "$ORDERER_CONFIG" | yq -r '.ca_url')
CA_NAME=$(echo "$ORDERER_CONFIG" | yq -r '.ca_name')
CA_TLS_CERT=$(echo "$ORDERER_CONFIG" | yq -r '.ca_tls_cert')
[[ "$CA_TLS_CERT" = /* ]] || CA_TLS_CERT="${PROJECT_ROOT}/${CA_TLS_CERT}"
ADMIN_PW=$(echo "$ORDERER_CONFIG" | yq -r '.admin_password // "ordererAdminpw"')

# 读取所有 orderer 节点列表
mapfile -t ORDERER_NODES < <(echo "$ORDERER_CONFIG" | yq -r '.nodes[] | "\(.name):\(.host):\(.port)"')

debug "Orderer 组织信息:"
debug "   MSPID      : $MSPID"
debug "   域名       : $DOMAIN"
debug "   CA         : $CA_URL ($CA_NAME)"
debug "   Admin 密码 : $ADMIN_PW"
debug "   节点数量   : ${#ORDERER_NODES[@]}"

# ====================== 路径准备 ======================
ORDERER_HOME="${PROJECT_ROOT}/organizations/ordererOrganizations/${DOMAIN}"
ADMIN_MSP_DIR="${ORDERER_HOME}/users/Admin@${DOMAIN}/msp"
ADMIN_TLS_DIR="${ORDERER_HOME}/users/Admin@${DOMAIN}/tls"
ORG_MSP_DIR="${ORDERER_HOME}/msp"

# 全局 TLS 根证书列表
ALL_TLS_ROOTS=()
for cert_path in "${PROJECT_ROOT}"/organizations/fabric-ca/*/ca-cert.pem; do
  [[ -f "$cert_path" ]] && ALL_TLS_ROOTS+=("$cert_path")
done

# ====================== 开始干活 ======================
debug "1. 注册 Orderer CA Admin"
enroll_ca_admin "$CA_NAME" "$CA_URL" "$CA_TLS_CERT" "$ORDERER_HOME" "$ADMIN_PW"

debug "2. 注册 Orderer Admin 用户"
register_identity "$CA_NAME" "$CA_TLS_CERT" "Ordereradmin" "$ADMIN_PW" "admin" "$ORDERER_HOME"
enroll_identity_msp "$CA_NAME" "$CA_TLS_CERT" "Ordereradmin" "$ADMIN_PW" "$ORDERER_HOME" "$ADMIN_MSP_DIR" "${CA_URL##*:}"
enroll_identity_tls "$CA_NAME" "$CA_TLS_CERT" "Ordereradmin" "$ADMIN_PW" "$ORDERER_HOME" "$ADMIN_TLS_DIR" localhost "${CA_URL##*:}"
copy_tls_files "$ADMIN_TLS_DIR" "${ALL_TLS_ROOTS[@]}"

# echo -e "\n3. 循环生成 ${#ORDERER_NODES[@]} 个 Orderer 节点"
for node_line in "${ORDERER_NODES[@]}"; do
  IFS=':' read -r node_name node_host node_port <<< "$node_line"
  ORDERER_MSP="${ORDERER_HOME}/orderers/${node_host}/msp"
  ORDERER_TLS="${ORDERER_HOME}/orderers/${node_host}/tls"

  debug "   生成 $node_host ($node_name) 端口: $node_port"

  register_identity "$CA_NAME" "$CA_TLS_CERT" "$node_name" "${node_name}pw" "orderer" "$ORDERER_HOME"
  enroll_identity_msp "$CA_NAME" "$CA_TLS_CERT" "$node_name" "${node_name}pw" "$ORDERER_HOME" "$ORDERER_MSP" "${CA_URL##*:}"
  enroll_identity_tls "$CA_NAME" "$CA_TLS_CERT" "$node_name" "${node_name}pw" "$ORDERER_HOME" "$ORDERER_TLS" "$node_host" "${CA_URL##*:}"
  copy_tls_files "$ORDERER_TLS" "${ALL_TLS_ROOTS[@]}"
  log_success "     证书生成成功：$node_host"
done

# ====================== 生成组织级 MSP ======================
debug "4. 生成 Orderer 组织级 MSP"
CA_CERT_NAME=$(basename "$(find "${ADMIN_MSP_DIR}/cacerts" -name "*.pem" | head -1)")
TLS_CERT_NAME="tls-$(basename "$CA_TLS_CERT")"

create_organization_msp \
  "$ORG_MSP_DIR" \
  "$ADMIN_MSP_DIR" \
  "$CA_TLS_CERT" \
  "$TLS_CERT_NAME" \
  "$CA_CERT_NAME"

ORG_CONFIG_YAML="${ORG_MSP_DIR}/config.yaml"
copy_msp_config "$ORG_CONFIG_YAML" "$ADMIN_MSP_DIR"

for node_line in "${ORDERER_NODES[@]}"; do
  IFS=':' read -r node_name node_host node_port <<< "$node_line"
  ORDERER_MSP="${ORDERER_HOME}/orderers/${node_host}/msp"

  copy_msp_config "$ORG_CONFIG_YAML" "$ORDERER_MSP"
done

log_success  "\nOrderer 组织证书生成完成！"
success "   共生成 Orderer 节点: ${#ORDERER_NODES[@]} 个"
success "   组织 MSP 路径: $ORG_MSP_DIR"
info "=================================================="
