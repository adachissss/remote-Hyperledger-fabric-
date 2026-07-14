#!/bin/bash
set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

CHANNEL_NAME="${1:-${CHANNEL_NAME:-$(get_primary_channel_name)}}"
ORDERER_DOMAIN=$(get_config_value_raw '.ordererOrg.domain')
ORDERER_HOST=$(get_config_value_raw '.ordererOrg.nodes[0].host')
ORDERER_PORT=$(get_config_value_raw '.ordererOrg.nodes[0].port')
ORDERER_ADMIN_PORT=$(get_config_value_raw '.ordererOrg.nodes[0].admin_port // (.ordererOrg.nodes[0].port + 3)')

export ORDERER_CA="${PROJECT_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/orderers/${ORDERER_HOST}/tls/ca.crt"
export ORDERER_ADDRESS="${ORDERER_HOST}:${ORDERER_PORT}"
export FABRIC_CFG_PATH="${PROJECT_ROOT}/config"
export OSNADMIN_TLS_CLIENTCERT="${PROJECT_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/users/Admin@${ORDERER_DOMAIN}/tls/server.crt"
export OSNADMIN_TLS_CLIENTKEY="${PROJECT_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/users/Admin@${ORDERER_DOMAIN}/tls/server.key"
export OSNADMIN_TLS_CLIENTROOTCAS="${PROJECT_ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}/users/Admin@${ORDERER_DOMAIN}/tls/ca.crt"
export ORDERER_ADMIN_ADDRESS="${ORDERER_HOST}:${ORDERER_ADMIN_PORT}"
export CHANNEL_NAME
export CHANNEL_PROFILE="${CHANNEL_PROFILE:-$(get_channel_profile "$CHANNEL_NAME")}"
[[ -n "$CHANNEL_PROFILE" ]] || {
  error "未在配置中找到通道: $CHANNEL_NAME"
  exit 1
}
export CHANNEL_BLOCK="${PROJECT_ROOT}/channel-artifacts/${CHANNEL_NAME}.block"
export PATH="${PROJECT_ROOT}/bin:${PATH}"
