#!/bin/bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$SCRIPT_ROOT"
REQUESTED_CONFIG_FILE="${CONFIG_FILE:-config/orgs.yaml}"
if [[ "$REQUESTED_CONFIG_FILE" != /* ]]; then
    REQUESTED_CONFIG_FILE="${PROJECT_ROOT}/${REQUESTED_CONFIG_FILE}"
fi
[[ -f "$REQUESTED_CONFIG_FILE" ]] || {
    echo "找不到网络配置文件: $REQUESTED_CONFIG_FILE" >&2
    exit 1
}
REQUESTED_CONFIG_FILE="$(realpath "$REQUESTED_CONFIG_FILE")"
if [[ "${ALLOW_EXTERNAL_CONFIG_FILE:-false}" != "true" ]]; then
    case "$REQUESTED_CONFIG_FILE" in
        "$PROJECT_ROOT"/*) ;;
        *)
            echo "配置文件必须位于当前网络工作区内: $PROJECT_ROOT" >&2
            exit 1
            ;;
    esac
fi
CONFIG_FILE="$REQUESTED_CONFIG_FILE"
export PROJECT_ROOT CONFIG_FILE
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"
mapfile -t CHANNEL_NAMES < <(get_channel_names)
FABRIC_NET_ID=$(get_config_value_raw '.network.id')
FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')
CONFIGURED_COMPOSE_PROJECT=$(get_config_value_raw '.network.compose_project // .network.id')
if [[ -n "${COMPOSE_PROJECT_NAME:-}" && "$CONFIGURED_COMPOSE_PROJECT" != "null" && "$COMPOSE_PROJECT_NAME" != "$CONFIGURED_COMPOSE_PROJECT" ]]; then
    error "Compose project 与网络配置不一致: $COMPOSE_PROJECT_NAME != $CONFIGURED_COMPOSE_PROJECT"
    exit 1
fi
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$CONFIGURED_COMPOSE_PROJECT}"
REMOVE_DOCKER_NETWORK_ON_DOWN=$(get_config_value_raw '.network.remove_docker_network_on_down // false')

[[ -n "$FABRIC_NET_ID" && "$FABRIC_NET_ID" != "null" ]] || {
    error "未在配置中读取到 .network.id"
    exit 1
}
[[ -n "$FABRIC_DOCKER_NET" && "$FABRIC_DOCKER_NET" != "null" ]] || {
    error "未在配置中读取到 .network.name"
    exit 1
}
[[ -n "$COMPOSE_PROJECT_NAME" && "$COMPOSE_PROJECT_NAME" != "null" ]] || {
    error "未在配置中读取到 Compose project"
    exit 1
}

[[ ${#CHANNEL_NAMES[@]} -gt 0 ]] || {
    error "网络配置至少需要一个通道"
    exit 1
}

ensure_docker_network() {
    if ! docker network inspect "$FABRIC_DOCKER_NET" >/dev/null 2>&1; then
        warn "Docker 网络不存在，正在创建: $FABRIC_DOCKER_NET"
        docker network create "$FABRIC_DOCKER_NET" >/dev/null
        success "Docker 网络创建完成: $FABRIC_DOCKER_NET"
    else
        info "Docker 网络已存在: $FABRIC_DOCKER_NET"
    fi
}

wait_for_ca_services() {
    local timeout_seconds="${FABRIC_CA_STARTUP_TIMEOUT_SECONDS:-60}"
    local entry ca_url ca_cert ca_port deadline
    local entries=()

    mapfile -t entries < <(
        get_config_value_raw '
          [
            (.peerOrgs[] | {url: .ca_url, cert: .ca_tls_cert}),
            (.ordererOrg | {url: .ca_url, cert: .ca_tls_cert})
          ][] | "\(.url)|\(.cert)"
        '
    )

    for entry in "${entries[@]}"; do
        IFS='|' read -r ca_url ca_cert <<< "$entry"
        ca_port="${ca_url##*:}"
        [[ "$ca_cert" = /* ]] || ca_cert="${PROJECT_ROOT}/${ca_cert}"
        deadline=$((SECONDS + timeout_seconds))

        info "等待 CA 就绪: ${ca_url}"
        while (( SECONDS < deadline )); do
            if nc -z -w1 127.0.0.1 "$ca_port" >/dev/null 2>&1 && [[ -s "$ca_cert" ]]; then
                success "CA 已就绪: ${ca_url}"
                break
            fi
            sleep 1
        done

        if ! nc -z -w1 127.0.0.1 "$ca_port" >/dev/null 2>&1 || [[ ! -s "$ca_cert" ]]; then
            error "CA 启动超时: ${ca_url}，未生成证书 ${ca_cert}"
            return 1
        fi
    done
}

wait_for_fabric_services() {
    local timeout_seconds="${FABRIC_NODE_STARTUP_TIMEOUT_SECONDS:-60}"
    local entry node_type node_name node_port deadline
    local org domain peer_count configured_port host_port_offset state_database couchdb_host org_index=0 peer_index
    local entries=()

    host_port_offset=$(get_config_value_raw '.network.network_port__start // 0')
    state_database=$(get_config_value_raw '.network.state_database // "leveldb"')

    mapfile -t entries < <(
        get_config_value_raw '.ordererOrg.nodes[] | "Orderer|\(.host)|\(.port)"'
        while IFS= read -r org; do
            [[ -n "$org" ]] || continue
            domain=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .domain")
            peer_count=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peer_count")
            for ((peer_index=0; peer_index<peer_count; peer_index++)); do
                configured_port=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peers[${peer_index}].peer_port // empty")
                node_port="${configured_port:-$((7000 + org_index * 100 + peer_index * 10 + 51))}"
                node_port=$((host_port_offset + node_port))
                node_name="$(get_config_value_raw '.network.env_prefix')-peer${peer_index}.${domain}"
                echo "Peer|${node_name}|${node_port}"
                if [[ "$state_database" == "couchdb" ]]; then
                    configured_port=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peers[${peer_index}].couchdb_port // empty")
                    node_port="${configured_port:-$((7000 + org_index * 100 + peer_index * 10 + 58))}"
                    node_port=$((host_port_offset + node_port))
                    couchdb_host=$(get_config_value_raw ".peerOrgs[] | select(.name == \"${org}\") | .peers[${peer_index}].couchdb_host // empty")
                    couchdb_host="${couchdb_host:-${node_name}-couchdb}"
                    echo "CouchDB|${couchdb_host}|${node_port}"
                fi
            done
            org_index=$((org_index + 1))
        done < <(get_peer_org_names)
    )

    for entry in "${entries[@]}"; do
        IFS='|' read -r node_type node_name node_port <<< "$entry"
        deadline=$((SECONDS + timeout_seconds))
        info "等待 ${node_type} 就绪: ${node_name}:${node_port}"
        while (( SECONDS < deadline )); do
            if nc -z -w1 127.0.0.1 "$node_port" >/dev/null 2>&1; then
                success "${node_type} 已就绪: ${node_name}:${node_port}"
                break
            fi
            sleep 1
        done

        if ! nc -z -w1 127.0.0.1 "$node_port" >/dev/null 2>&1; then
            error "${node_type} 启动超时: ${node_name}:${node_port}"
            return 1
        fi
    done
}

fix_generated_ownership() {
    [[ -d "${PROJECT_ROOT}/organizations" ]] || return 0

    local owner
    owner="$(id -u):$(id -g)"
    if [[ "$(id -u)" -eq 0 ]]; then
        chown -R "$owner" "${PROJECT_ROOT}/organizations" || true
    elif command -v sudo >/dev/null 2>&1; then
        sudo chown -R "$owner" "${PROJECT_ROOT}/organizations" || true
    else
        warn "无法修正 organizations 目录权限：当前用户无 chown 权限且未安装 sudo"
    fi
}

do_up() {
    info "===== 检查 Docker 网络 ====="
    ensure_docker_network

    info "===== 生成 CA Compose ====="
    cd "$PROJECT_ROOT/script"
    ./generate-docker-compose-ca.sh

    info "===== 启动 CA ====="
    cd "$PROJECT_ROOT/docker"
    docker compose -f docker-compose-ca.yaml up -d

    info "===== 等待 CA 服务就绪 ====="
    wait_for_ca_services

    info "===== 组织目录授权 ====="
    cd "$PROJECT_ROOT"
    fix_generated_ownership

    info "===== 生成 Peer/Orderer 组织证书 ====="
    cd "$PROJECT_ROOT/script"

    mapfile -t PEER_ORGS < <(get_peer_org_names)
    for org in "${PEER_ORGS[@]}"; do
        info "===== 生成 Peer 组织证书: $org ====="
        ./generate-peer-org.sh "$org"
    done

    ./generate-orderer-certs.sh
    ./generate-docker-compose-orderers.sh
    ./generate-docker-compose-peers.sh
    ./generate-channel-config.sh



    info "===== 启动 Peer + Orderer 容器 ====="
    cd "$PROJECT_ROOT/docker"
    docker compose -f docker-compose-peers.yaml up -d
    docker compose -f docker-compose-orderers.yaml up -d

    info "===== 等待 Peer + Orderer 服务就绪 ====="
    wait_for_fabric_services

    info "===== 修改 /etc/hosts 映射 ====="
    cd "$PROJECT_ROOT/script"
    ./docker-ip-hosts-Mapping.sh

    for channel_name in "${CHANNEL_NAMES[@]}"; do
        info "===== Orderer 加入通道 ($channel_name) ====="
        cd "$PROJECT_ROOT/script"
        ./osnadmin-examples.sh "$channel_name"
    done

    info "===== peer core ====="
    cd "$PROJECT_ROOT/script"
    ./generate_core_yaml.sh

    for channel_name in "${CHANNEL_NAMES[@]}"; do
        cd "$PROJECT_ROOT/script"
        info "===== Peer 加入通道 ($channel_name) ====="
        ./joinChannel.sh "$channel_name"
    done




    success "===== UP 完成 Fabric 网络已全部启动 ====="
}

compose_if_exists() {
    local compose_file="$1"
    shift

    cd "$PROJECT_ROOT/docker"
    if [[ -f "$compose_file" ]]; then
        docker compose -f "$compose_file" "$@" || true
    else
        warn "Compose 文件不存在，跳过: docker/$compose_file"
    fi
}

# ============================
# 子函数：STOP 阶段（保留容器、卷、证书、通道文件）
# ============================
do_stop() {
    info "===== 暂停 Peer/Orderer/CA 容器 ====="
    compose_if_exists docker-compose-peers.yaml stop
    compose_if_exists docker-compose-orderers.yaml stop
    compose_if_exists docker-compose-ca.yaml stop
    success "===== STOP 完成！容器已暂停，数据未清理 ====="
}

# ============================
# 子函数：RESTART 阶段（启动已存在容器，不重新生成证书）
# ============================
do_restart() {
    info "===== 检查 Docker 网络 ====="
    ensure_docker_network

    info "===== 重新启动 CA 容器 ====="
    compose_if_exists docker-compose-ca.yaml start
    wait_for_ca_services

    info "===== 重新启动 Peer + Orderer 容器 ====="
    compose_if_exists docker-compose-orderers.yaml start
    compose_if_exists docker-compose-peers.yaml start
    wait_for_fabric_services

    info "===== 修改 /etc/hosts 映射 ====="
    cd "$PROJECT_ROOT/script"
    ./docker-ip-hosts-Mapping.sh

    success "===== RESTART 完成！Fabric 容器已重新启动 ====="
}

# ============================
# 子函数：DOWN 阶段
# ============================
do_down() {
    info "===== 清理本网络 hosts 映射 ====="
    cd "$PROJECT_ROOT/script"
    ./docker-ip-hosts-Mapping.sh remove || true

    info "===== 停止 Peer/Orderer 容器 ====="
    cd "$PROJECT_ROOT/docker"

    if [[ -f docker-compose-peers.yaml ]]; then
        docker compose -f docker-compose-peers.yaml down -v || true
    fi
    if [[ -f docker-compose-orderers.yaml ]]; then
        docker compose -f docker-compose-orderers.yaml down -v || true
    fi
    if [[ -f docker-compose-ca.yaml ]]; then
        docker compose -f docker-compose-ca.yaml down -v || true
    fi

    if [[ "$REMOVE_DOCKER_NETWORK_ON_DOWN" == "true" ]] && docker network inspect "$FABRIC_DOCKER_NET" >/dev/null 2>&1; then
        info "===== 删除本网络 Docker network ====="
        docker network rm "$FABRIC_DOCKER_NET" >/dev/null || warn "Docker network 仍被占用，未删除: $FABRIC_DOCKER_NET"
    fi

    info "===== 删除组织证书与通道文件 ====="
    cd "$PROJECT_ROOT"
    fix_generated_ownership

    rm -rf organizations/
    rm -rf channel-artifacts/

    success "===== DOWN 完成！环境已清理 ====="
}

# ============================
# 主入口
# ============================
case "${1:-}" in
    up)
        do_up
        ;;
    stop)
        do_stop
        ;;
    restart)
        do_restart
        ;;
    down)
        do_down
        ;;
    *)
        echo
        warn "用法："
        echo "  ./network.sh up        启动所有 Fabric 组件并初始化网络"
        echo "  ./network.sh stop      暂停所有 Fabric 容器，保留数据"
        echo "  ./network.sh restart   重新启动已暂停的 Fabric 容器"
        echo "  ./network.sh down      停止并清理环境"
        echo
        exit 1
        ;;
esac
