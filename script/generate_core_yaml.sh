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

# ========================================
# 网络前缀获取
# ========================================
FABRIC_NET_PREFIX=$(yq -r '.network.env_prefix' "$CONFIG_FILE")

# ========================================
# 复用 joinChannel 中的获取 peer 逻辑
# ========================================
get_all_peers() {
    docker ps --format '{{.Names}}' \
        | grep -E "${FABRIC_NET_PREFIX}-peer[0-9]+\.org[0-9]+\.example\.com" \
        | sort \
        | while read -r container; do
            addr=$(docker inspect --format='{{range .Config.Env}}{{if eq (index (split . "=") 0) "CORE_PEER_ADDRESS"}}{{index (split . "=") 1}}{{end}}{{end}}' "$container")
            msp=$(docker inspect --format='{{range .Config.Env}}{{if eq (index (split . "=") 0) "CORE_PEER_LOCALMSPID"}}{{index (split . "=") 1}}{{end}}{{end}}' "$container")

            [[ -n "$addr" && -n "$msp" ]] || continue

            printf '%s|%s|%s\n' "$container" "$addr" "$msp"
        done
}

# ========================================
# 主函数
# ========================================
main() {
    log_info "开始根据正在运行的 peer 自动生成 core.yaml ..."

    mapfile -t peers < <(get_all_peers)

    if [[ ${#peers[@]} -eq 0 ]]; then
        log_error "没有发现正在运行的 peer 容器！无法生成 core.yaml"
        exit 1
    fi

    for peer_line in "${peers[@]}"; do
        IFS='|' read -r peer_host address msp <<< "$peer_line"

        log_info "处理 peer: $peer_host  地址: $address  MSP: $msp"

        domain="${peer_host#*.}"
        peer_path="${ROOT_DIR}/${FABRIC_NET_PREFIX}-${domain}/peers/${peer_host}"

        if [[ ! -d "$peer_path" ]]; then
            log_debug "未找到路径: $peer_path ，跳过"
            continue
        fi

        # 端口从容器里的 address 获取
        peer_port="${address##*:}"
        chaincode_port=$(( peer_port + 1 ))

        peer_number="${peer_host%%.*}"        # peer0
        peer_number="${peer_number//[!0-9]/}" # 变成数字：0
        ops_port=$(( 9144 + peer_number ))

        gossip="${peer_host}:${peer_port}"
        output_file="${peer_path}/core.yaml"

        # log_debug "生成 core.yaml -> $output_file"

        sed -e "s#{{PEER_ID}}#${peer_host}#g" \
            -e "s#{{PEER_PORT}}#${peer_port}#g" \
            -e "s#{{CHAINCODE_PORT}}#${chaincode_port}#g" \
            -e "s#{{OPS_PORT}}#${ops_port}#g" \
            -e "s#{{PEER_ENDPOINT}}#${gossip}#g" \
            -e "s#{{PEER_EXTERNAL}}#${gossip}#g" \
            -e "s#{{GOSSIP_BOOTSTRAP}}#${gossip}#g" \
            -e "s#{{MSP_ID}}#${msp}#g" \
            -e "s#{{MSP_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/msp#g" \
            -e "s#{{TLS_CERT_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/tls/server.crt#g" \
            -e "s#{{TLS_KEY_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/tls/server.key#g" \
            -e "s#{{TLS_CA_PATH}}#/etc/hyperledger/fabric/peers/${peer_host}/tls/ca.crt#g" \
            -e "s#{{NETWORK_ID}}#fabricnet#g" \
            -e "s#{{SNAPSHOT_ROOT_DIR}}#${SNAPSHOT_ROOT_DIR}#g" \
            "$TEMPLATE_FILE" > "$output_file"

        # log_success "生成成功：$output_file"
    done

    log_success "core.yaml 生成完毕！"
}

# ========================================
# 脚本入口
# ========================================
main