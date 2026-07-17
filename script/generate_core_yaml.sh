#!/bin/bash
set -euo pipefail

# ========================================
# 环境变量和路径配置
# ========================================
if [[ -z "${PROJECT_ROOT:-}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" #获取当前脚本目录
    PROJECT_ROOT="$(cd "$SCRIPT_DIR" && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

TEMPLATE_FILE="${PROJECT_ROOT}/core-template.yaml"
ROOT_DIR="${PROJECT_ROOT}/organizations/peerOrganizations"
SNAPSHOT_ROOT_DIR="/var/hyperledger/production/snapshots"

source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

FABRIC_NET_ID=$(get_config_value_raw '.network.id')
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')

get_peer_port() {
    local org_name="$1" peer_index="$2" field="$3" default_offset="$4"
    local configured
    configured=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org_name}\") | .peers[${peer_index}].${field} // empty")
    if [[ -n "$configured" && "$configured" != "null" ]]; then
        echo "$configured"
        return
    fi

    local org_index
    org_index=$(get_peer_org_index "$org_name")
    echo $((7000 + org_index * 100 + peer_index * 10 + default_offset))
}

# ========================================
# 主函数
# ========================================
main() {
    log_info "开始根据网络配置生成 peer core.yaml ..."

    local generated=0
    local org org_config msp domain peer_count peer_host peer_path
    local peer_port chaincode_port ops_port bootstrap_port gossip bootstrap output_file
    while IFS= read -r org; do
        [[ -n "$org" ]] || continue
        org_config=$(load_peer_org_config "$org")
        msp=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.mspid')
        domain=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.domain')
        peer_count=$(printf '%s' "$org_config" | "$YQ_BIN" -r '.peer_count')
        bootstrap_port=$(get_peer_port "$org" 0 peer_port 51)

        for ((peer_index=0; peer_index<peer_count; peer_index++)); do
            peer_host="${FABRIC_NET_PREFIX}-peer${peer_index}.${domain}"
            peer_path="${ROOT_DIR}/${FABRIC_NET_PREFIX}-${domain}/peers/${peer_host}"
            [[ -d "$peer_path" ]] || {
                log_error "未找到 peer 目录: $peer_path"
                exit 1
            }

            peer_port=$(get_peer_port "$org" "$peer_index" peer_port 51)
            chaincode_port=$(get_peer_port "$org" "$peer_index" chaincode_port 52)
            ops_port=$(get_peer_port "$org" "$peer_index" metrics_port 55)
            gossip="${peer_host}:${peer_port}"
            bootstrap="${FABRIC_NET_PREFIX}-peer0.${domain}:${bootstrap_port}"
            output_file="${peer_path}/core.yaml"

            log_info "处理 peer: $peer_host  地址: $gossip  MSP: $msp"

            sed -e "s#{{PEER_ID}}#${peer_host}#g" \
                -e "s#{{PEER_PORT}}#${peer_port}#g" \
                -e "s#{{CHAINCODE_PORT}}#${chaincode_port}#g" \
                -e "s#{{OPS_PORT}}#${ops_port}#g" \
                -e "s#{{PEER_ENDPOINT}}#${gossip}#g" \
                -e "s#{{PEER_EXTERNAL}}#${gossip}#g" \
                -e "s#{{GOSSIP_BOOTSTRAP}}#${bootstrap}#g" \
                -e "s#{{MSP_ID}}#${msp}#g" \
                -e "s#{{MSP_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/msp#g" \
                -e "s#{{TLS_CERT_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/tls/server.crt#g" \
                -e "s#{{TLS_KEY_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/tls/server.key#g" \
                -e "s#{{TLS_CA_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/tls/ca.crt#g" \
                -e "s#{{NETWORK_ID}}#${FABRIC_NET_ID}#g" \
                -e "s#{{DOCKER_NETWORK}}#${FABRIC_DOCKER_NET}#g" \
                -e "s#{{SNAPSHOT_ROOT_DIR}}#${SNAPSHOT_ROOT_DIR}#g" \
                "$TEMPLATE_FILE" > "$output_file"
            generated=$((generated + 1))
        done
    done < <(get_peer_org_names)

    [[ "$generated" -gt 0 ]] || { log_error "网络配置中没有 peer 节点"; exit 1; }

    log_success "core.yaml 生成完毕，共生成 $generated 个节点配置"
}

# ========================================
# 脚本入口
# ========================================
main
