#!/bin/bash
set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
else
  SCRIPT_DIR="${PROJECT_ROOT}/script"
fi

CHANNEL_NAME="${1:-${CHANNEL_NAME:-}}"
source "$SCRIPT_DIR/env.sh" "$CHANNEL_NAME"

info "========== Step 1: 生成通道的创世区块 =========="
configtxgen \
    -profile ${CHANNEL_PROFILE} \
    -outputBlock ${CHANNEL_BLOCK} \
    -channelID ${CHANNEL_NAME}

if [[ $? -ne 0 ]]; then
    error "✘ 生成通道块失败，请检查 configtx.yaml 中是否存在 profile: ThreeOrgsChannel"
    exit 1
fi
success "通道块已生成: ${CHANNEL_BLOCK}"

# 检查生成的区块文件
if [[ ! -f ${CHANNEL_BLOCK} ]]; then
    error "✘ 通道区块文件不存在: ${CHANNEL_BLOCK}"
    exit 1
fi

debug "通道区块文件确认存在，大小: $(ls -lh ${CHANNEL_BLOCK} | awk '{print $5}')"

# 检查 TLS 客户端证书的 SAN 扩展
info "========== Step 2: 检查 Admin 证书 =========="
debug "证书路径: $OSNADMIN_TLS_CLIENTCERT"

if [[ ! -f $OSNADMIN_TLS_CLIENTCERT ]]; then
    error "✘ Admin 客户端证书不存在: $OSNADMIN_TLS_CLIENTCERT"
    exit 1
fi

if [[ ! -f $OSNADMIN_TLS_CLIENTKEY ]]; then
    error "✘ Admin 客户端私钥不存在: $OSNADMIN_TLS_CLIENTKEY"
    exit 1
fi

if [[ ! -f $OSNADMIN_TLS_CLIENTROOTCAS ]]; then
    error "✘ Admin CA 证书不存在: $OSNADMIN_TLS_CLIENTROOTCAS"
    exit 1
fi

success "所有证书文件存在"

# 检查证书内容
debug "检查证书中的 SAN 扩展:"
openssl x509 -in $OSNADMIN_TLS_CLIENTCERT -text -noout | grep -A 3 "Subject Alternative Name" || warn " 无 SAN 扩展，这可能会导致连接问题"

# 函数：加入一个 Orderer 节点到通道
function join_channel_with_orderer() {
    local ORDERER_ADDRESS=$1
    local ORDERER_NAME=$(echo $ORDERER_ADDRESS | cut -d':' -f1)

    debug "--> 尝试将通道加入到 Orderer: ${ORDERER_ADDRESS}"

    # 首先测试连接
    warn "测试与 ${ORDERER_ADDRESS} 的连接..."

    # 尝试列出现有通道来测试连接
    osnadmin channel list \
        -o $ORDERER_ADDRESS \
        --client-cert $OSNADMIN_TLS_CLIENTCERT \
        --client-key $OSNADMIN_TLS_CLIENTKEY \
        --ca-file $OSNADMIN_TLS_CLIENTROOTCAS 2>/dev/null

    if [[ $? -ne 0 ]]; then
        error "✘ 无法连接到 ${ORDERER_ADDRESS}，请检查:"
        warn "  1. Orderer 是否正在运行"
        warn "  2. 端口是否正确开放"
        warn "  3. TLS 证书是否匹配"
        warn "  4. 网络连接是否正常"
        return 1
    fi

    success "连接测试成功"

    # 执行加入通道操作
    debug "正在加入通道..."

    osnadmin channel join \
        --channelID $CHANNEL_NAME \
        --config-block $CHANNEL_BLOCK \
        -o $ORDERER_ADDRESS \
        --client-cert $OSNADMIN_TLS_CLIENTCERT \
        --client-key $OSNADMIN_TLS_CLIENTKEY \
        --ca-file $OSNADMIN_TLS_CLIENTROOTCAS

    local join_result=$?

    if [[ $join_result -ne 0 ]]; then
        error " 加入失败: ${ORDERER_ADDRESS}"
        warn "尝试获取详细错误信息..."

        # 再次尝试列出通道，看是否已经存在
        osnadmin channel list \
            -o $ORDERER_ADDRESS \
            --client-cert $OSNADMIN_TLS_CLIENTCERT \
            --client-key $OSNADMIN_TLS_CLIENTKEY \
            --ca-file $OSNADMIN_TLS_CLIENTROOTCAS

        return 1
    fi

    success "加入成功: ${ORDERER_ADDRESS}"
    return 0
}

info "========== Step 3: 所有 Orderer 加入通道 =========="

# 记录失败的 orderer
failed_orderers=()

# 尝试加入每个 orderer
mapfile -t ORDERER_ADMIN_ADDRESSES < <(get_config_value_raw '.ordererOrg.nodes[] | (.host + ":" + ((.admin_port // (.port + 3))|tostring))')
for orderer_addr in "${ORDERER_ADMIN_ADDRESSES[@]}"; do
    if ! join_channel_with_orderer "$orderer_addr"; then
        failed_orderers+=("$orderer_addr")
    fi
    sleep 2
done

# 检查是否有失败的 orderer
if [[ ${#failed_orderers[@]} -gt 0 ]]; then
    error "以下 Orderer 加入失败:"
    for failed in "${failed_orderers[@]}"; do
        warn "  - $failed"
    done
    warn "建议检查:"
    warn "  1. Docker 容器状态: docker ps | grep orderer"
    warn "  2. Orderer 日志: docker logs orderer1.example.com"
    warn "  3. 网络连接: telnet orderer1.example.com 7053"
fi

info "========== Step 4: 验证通道状态 =========="

# 验证每个成功的 orderer
for orderer_addr in "${ORDERER_ADMIN_ADDRESSES[@]}"; do
    if [[ ! " ${failed_orderers[@]} " =~ " ${orderer_addr} " ]]; then
        debug "检查 ${orderer_addr} 上的通道:"
        osnadmin channel list \
            -o $orderer_addr \
            --client-cert $OSNADMIN_TLS_CLIENTCERT \
            --client-key $OSNADMIN_TLS_CLIENTKEY \
            --ca-file $OSNADMIN_TLS_CLIENTROOTCAS
    fi
done

# 最终状态报告
if [[ ${#failed_orderers[@]} -eq 0 ]]; then
    info "所有步骤完成：通道 '${CHANNEL_NAME}' 已成功加入到所有 Orderer 节点"
else
    warn "部分完成：通道 '${CHANNEL_NAME}' 已加入到 $(( ${#ORDERER_ADMIN_ADDRESSES[@]} - ${#failed_orderers[@]} )) 个 Orderer 节点"
    warn "请解决失败的 Orderer 问题后重新运行脚本"
fi
