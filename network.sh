#!/bin/bash
set -euo pipefail

PROJECT_ROOT=$(pwd)
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"
mapfile -t CHANNEL_NAMES < <(get_channel_names)
FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(get_config_value_raw '.network.compose_project // .network.id')}"

[[ ${#CHANNEL_NAMES[@]} -gt 0 ]] || {
    error "网络配置至少需要一个通道"
    exit 1
}

ensure_docker_network() {
    [[ -n "$FABRIC_DOCKER_NET" && "$FABRIC_DOCKER_NET" != "null" ]] || {
        error "未在配置中读取到 .network.name"
        exit 1
    }

    if ! docker network inspect "$FABRIC_DOCKER_NET" >/dev/null 2>&1; then
        warn "Docker 网络不存在，正在创建: $FABRIC_DOCKER_NET"
        docker network create "$FABRIC_DOCKER_NET" >/dev/null
        success "Docker 网络创建完成: $FABRIC_DOCKER_NET"
    else
        info "Docker 网络已存在: $FABRIC_DOCKER_NET"
    fi
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

    info "===== 重新启动 Peer + Orderer 容器 ====="
    compose_if_exists docker-compose-orderers.yaml start
    compose_if_exists docker-compose-peers.yaml start

    info "===== 修改 /etc/hosts 映射 ====="
    cd "$PROJECT_ROOT/script"
    ./docker-ip-hosts-Mapping.sh

    success "===== RESTART 完成！Fabric 容器已重新启动 ====="
}

# ============================
# 子函数：DOWN 阶段
# ============================
do_down() {
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
