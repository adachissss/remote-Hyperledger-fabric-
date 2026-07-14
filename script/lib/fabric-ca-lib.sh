#!/bin/bash
# scripts/lib/fabric-ca-lib.sh

set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
fi

LEGACY_CONFIG_FILE_DEFAULT="${PROJECT_ROOT}/config/orgs.yaml"
BASE_CONFIG_FILE_DEFAULT="${PROJECT_ROOT}/config/base/network.yaml"
TOPOLOGY_CONFIG_FILE_DEFAULT="${PROJECT_ROOT}/config/base/topology.yaml"
PROFILE_CONFIG_DIR_DEFAULT="${PROJECT_ROOT}/config/profiles"
LOCAL_OVERRIDE_FILE_DEFAULT="${PROJECT_ROOT}/config/local.override.yaml"
CONFIG_PROFILE_DEFAULT="dev"

: "${CONFIG_FILE:=""}"
: "${LEGACY_CONFIG_FILE:="$LEGACY_CONFIG_FILE_DEFAULT"}"
: "${BASE_CONFIG_FILE:="$BASE_CONFIG_FILE_DEFAULT"}"
: "${TOPOLOGY_CONFIG_FILE:="$TOPOLOGY_CONFIG_FILE_DEFAULT"}"
: "${PROFILE_CONFIG_DIR:="$PROFILE_CONFIG_DIR_DEFAULT"}"
: "${LOCAL_OVERRIDE_FILE:="$LOCAL_OVERRIDE_FILE_DEFAULT"}"
: "${CONFIG_PROFILE:="$CONFIG_PROFILE_DEFAULT"}"

# 统一输出语义：白=过程/调试，绿=阶段成功，蓝=最终完成/阶段标题，黄=提醒，红=失败
WHITE='\033[1;37m'
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
BOLD='\033[1m'
RESET='\033[0m'

_emit_log() {
  local stream="$1"
  local color="$2"
  local label="$3"
  shift 3

  if [[ "$stream" == "stderr" ]]; then
    echo -e "${color}${BOLD}${label}$*${RESET}" >&2
  else
    echo -e "${color}${BOLD}${label}$*${RESET}"
  fi
}

log_info()    { _emit_log stderr "$BLUE" "[INFO]   " "$@"; }
log_success() { _emit_log stderr "$GREEN" "[OK]     " "$@"; }
log_error()   { _emit_log stderr "$RED" "[ERROR]  " "$@"; }
log_warning() { _emit_log stderr "$YELLOW" "[WARN]   " "$@"; }
log_debug()   { _emit_log stderr "$WHITE" "[DEBUG]  " "$@"; }

info()    { _emit_log stdout "$BLUE" "[INFO]   " "$@"; }
success() { _emit_log stdout "$GREEN" "[SUCCESS]" "$@"; }
warn()    { _emit_log stdout "$YELLOW" "[WARN]   " "$@"; }
warning() { log_warning "$@"; }
error()   { _emit_log stderr "$RED" "[ERROR]  " "$@"; }
debug()   { _emit_log stdout "$WHITE" "[DEBUG]  " "$@"; }

# 工具路径与检查
export PATH="${PROJECT_ROOT}/bin:${PATH}"
FABRIC_CA_CLIENT="${FABRIC_CA_CLIENT_HOME:-${PROJECT_ROOT}/bin/fabric-ca-client}"
CONFIGTXGEN="${CONFIGTXGEN_HOME:-${PROJECT_ROOT}/bin/configtxgen}"
YQ_BIN="${YQ_BIN:-${PROJECT_ROOT}/bin/yq}"

command -v nc >/dev/null 2>&1 || { log_error "缺少依赖命令：nc"; exit 1; }
[[ -x "$YQ_BIN" ]] || { log_error "缺少可执行文件：$YQ_BIN"; exit 1; }

normalize_legacy_config() {
  local source_file="$1"
  local normalized_file="$2"

  "$YQ_BIN" ea '. as $cfg ireduce ({}; {
    network: ($cfg.network // {}),
    ordererOrg: ($cfg.ordererOrg // {}),
    peerOrgs: ($cfg.peerOrgs // []),
    channels: (
      if $cfg.channels then $cfg.channels
      else [
        {
          name: "mychannel",
          profile: "ThreeOrgsChannel",
          consortium: "SampleConsortium",
          memberOrgs: (($cfg.peerOrgs // []) | map(.name))
        }
      ] end
    ),
    profiles: ($cfg.profiles // {
      genesis: "ThreeOrgsOrdererGenesis"
    })
  })' "$source_file" > "$normalized_file"
}

resolve_config_file() {
  if [[ -n "$CONFIG_FILE" ]]; then
    [[ -f "$CONFIG_FILE" ]] || {
      log_error "找不到配置文件 $CONFIG_FILE"
      exit 1
    }

    if [[ "$CONFIG_FILE" == "$LEGACY_CONFIG_FILE" ]]; then
      local normalized_config
      normalized_config="$(mktemp "${TMPDIR:-/tmp}/plus-fabric-legacy-config.XXXXXX.yaml")"
      normalize_legacy_config "$CONFIG_FILE" "$normalized_config"
      CONFIG_FILE="$normalized_config"
      CONFIG_SOURCE="legacy"
    fi

    return 0
  fi

  local profile_config="${PROFILE_CONFIG_DIR}/${CONFIG_PROFILE}.yaml"
  local layered_config_files=()

  [[ -f "$BASE_CONFIG_FILE" ]] && layered_config_files+=("$BASE_CONFIG_FILE")
  [[ -f "$TOPOLOGY_CONFIG_FILE" ]] && layered_config_files+=("$TOPOLOGY_CONFIG_FILE")
  [[ -f "$profile_config" ]] && layered_config_files+=("$profile_config")
  [[ -f "$LOCAL_OVERRIDE_FILE" ]] && layered_config_files+=("$LOCAL_OVERRIDE_FILE")

  if [[ ${#layered_config_files[@]} -gt 0 ]]; then
    local merged_config
    merged_config="$(mktemp "${TMPDIR:-/tmp}/plus-fabric-config.XXXXXX.yaml")"
    "$YQ_BIN" ea '. as $item ireduce ({}; . * $item)' "${layered_config_files[@]}" > "$merged_config"
    CONFIG_FILE="$merged_config"
    CONFIG_SOURCE="layered"
    return 0
  fi

  [[ -f "$LEGACY_CONFIG_FILE" ]] || {
    log_error "找不到配置文件：$LEGACY_CONFIG_FILE"
    log_error "请提供 CONFIG_FILE，或创建分层配置/legacy orgs.yaml"
    exit 1
  }

  local normalized_config
  normalized_config="$(mktemp "${TMPDIR:-/tmp}/plus-fabric-legacy-config.XXXXXX.yaml")"
  normalize_legacy_config "$LEGACY_CONFIG_FILE" "$normalized_config"
  CONFIG_FILE="$normalized_config"
  CONFIG_SOURCE="legacy"
}

resolve_config_file

# 必须真实存在可执行文件（bin 下的 + PATH 中的）
[[ -x "$FABRIC_CA_CLIENT" ]] || { log_error "缺少可执行文件：$FABRIC_CA_CLIENT"; exit 1; }
[[ -x "$CONFIGTXGEN" ]] || { log_error "缺少可执行文件：$CONFIGTXGEN"; exit 1; }


#基础工具函数
check_file_exists() {
  [[ -f "$1" ]] || { log_error "文件不存在: $1"; exit 1; }
}

check_ca_reachable() {
  local url="$1"
  local addr="${url#https://}"
  local host="${addr%:*}"
  local port="${addr#*:}"
  nc -z -w3 "$host" "$port" >/dev/null 2>&1 || {
    log_error "CA 连接失败: $url"
    exit 1
  }
}

clean_directory() {
  local dir="$1"
  [[ -d "$dir" ]] && rm -rf "$dir"
  mkdir -p "$dir"
  chmod 755 "$dir"
}

write_config_yaml() {
  local msp_path="$1"
  debug "写入 MSP 配置: ${msp_path}/config.yaml"
  local ca_cert_name="$2"
  cat > "${msp_path}/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: orderer
EOF
}

setup_msp_tlscacerts() {
  local msp_dir="$1" tls_cert="$2" cert_name="$3"
  mkdir -p "${msp_dir}/tlscacerts"
  cp "$tls_cert" "${msp_dir}/tlscacerts/${cert_name}"
}

copy_tls_files() {
  local tls_dir="$1"; shift
  local roots=("$@")

  for d in tlscacerts signcerts keystore; do
    [[ -d "${tls_dir}/${d}" && -n "$(ls -A "${tls_dir}/${d}")" ]] || {
      log_error "TLS 目录结构异常: ${tls_dir}/${d}"
      exit 1
    }
  done

  cp "${tls_dir}/signcerts/"* "${tls_dir}/server.crt"
  cp "${tls_dir}/keystore/"*   "${tls_dir}/server.key"

  > "${tls_dir}/ca.crt"
  for cert in "${roots[@]}"; do
    check_file_exists "$cert"
    cat "$cert" >> "${tls_dir}/ca.crt"
  done
}

# 核心操作函数
enroll_ca_admin() {
  local ca_name="$1" ca_url="$2" tls_cert="$3" home="$4"

  check_file_exists "$tls_cert"
  check_ca_reachable "$ca_url"

  export FABRIC_CA_CLIENT_HOME="$home"
  "$FABRIC_CA_CLIENT" enroll \
    -u "https://admin:adminpw@${ca_url#https://}" \
    --caname "$ca_name" \
    --tls.certfiles "$tls_cert" >/dev/null
}

register_identity() {
  local ca_name="$1" tls_cert="$2" name="$3" \
        secret="$4" type="$5"      home="$6"

  export FABRIC_CA_CLIENT_HOME="$home"
  "$FABRIC_CA_CLIENT" getidentity --id "$name" --caname "$ca_name" \
    --tls.certfiles "$tls_cert" >/dev/null 2>&1 && return 0

  "$FABRIC_CA_CLIENT" register \
    --caname "$ca_name" \
    --id.name "$name" \
    --id.secret "$secret" \
    --id.type "$type" \
    --tls.certfiles "$tls_cert" >/dev/null
}

enroll_identity_msp() {
  local ca_name="$1" tls_cert="$2" name="$3" secret="$4" \
        home="$5"   msp_dir="$6"  port="$7"

  export FABRIC_CA_CLIENT_HOME="$home"
  "$FABRIC_CA_CLIENT" enroll \
    -u "https://${name}:${secret}@localhost:${port}" \
    --caname "$ca_name" \
    -M "$msp_dir" \
    --tls.certfiles "$tls_cert" >/dev/null
}

enroll_identity_tls() {
  local ca_name="$1" tls_cert="$2" name="$3" secret="$4" \
        home="$5"   tls_dir="$6"  host="$7"  port="$8"

  export FABRIC_CA_CLIENT_HOME="$home"
  "$FABRIC_CA_CLIENT" enroll \
    -u "https://${name}:${secret}@localhost:${port}" \
    --caname "$ca_name" \
    -M "$tls_dir" \
    --enrollment.profile tls \
    --csr.cn "$host" \
    --csr.hosts "${host},localhost,127.0.0.1" \
    --tls.certfiles "$tls_cert" >/dev/null
}

create_organization_msp() {
  local org_msp_dir="$1" admin_msp_dir="$2"
  local tls_ca_cert="$3" tls_ca_cert_name="$4" ca_cert_name="$5"

  clean_directory "$org_msp_dir"
  mkdir -p "${org_msp_dir}/cacerts" "${org_msp_dir}/tlscacerts" "${org_msp_dir}/admincerts" "${org_msp_dir}/signcerts"

  cp "${admin_msp_dir}/cacerts/"* "${org_msp_dir}/cacerts/"

  cp "${admin_msp_dir}/signcerts/"* "${org_msp_dir}/admincerts/"

  cp "${admin_msp_dir}/signcerts/"* "${org_msp_dir}/signcerts/"

  if [[ -f "${admin_msp_dir}/IssuerPublicKey" ]]; then
    cp "${admin_msp_dir}/IssuerPublicKey" "${org_msp_dir}/"
  fi

  if [[ -f "${admin_msp_dir}/IssuerRevocationPublicKey" ]]; then
    cp "${admin_msp_dir}/IssuerRevocationPublicKey" "${org_msp_dir}/"
  fi

  write_config_yaml "$org_msp_dir" "$ca_cert_name"
  setup_msp_tlscacerts "$org_msp_dir" "$tls_ca_cert" "$tls_ca_cert_name"
}

get_config_value() {
  local expr="$1"
  "$YQ_BIN" eval "$expr" "$CONFIG_FILE"
}

get_config_value_raw() {
  local expr="$1"
  "$YQ_BIN" -r "$expr" "$CONFIG_FILE"
}

get_peer_org_names() {
  get_config_value_raw '.peerOrgs[].name'
}

get_peer_org_index() {
  local org_name="$1"
  local index=0
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if [[ "$candidate" == "$org_name" ]]; then
      echo "$index"
      return 0
    fi
    index=$((index + 1))
  done < <(get_peer_org_names)

  log_error "未找到组织索引: $org_name"
  exit 1
}

get_channel_names() {
  get_config_value_raw '.channels[].name'
}

get_primary_channel_name() {
  get_config_value_raw '.channels[0].name'
}

get_channel_profile() {
  local channel_name="$1"
  get_config_value_raw ".channels[] | select(.name == \"${channel_name}\") | .profile"
}

get_channel_consortium() {
  local channel_name="$1"
  get_config_value_raw ".channels[] | select(.name == \"${channel_name}\") | .consortium"
}

get_channel_member_orgs() {
  local channel_name="$1"
  get_config_value_raw ".channels[] | select(.name == \"${channel_name}\") | .memberOrgs[]"
}

load_primary_channel_config() {
  "$YQ_BIN" eval '.channels[0]' "$CONFIG_FILE"
}

load_channel_config() {
  local channel_name="$1"
  "$YQ_BIN" eval ".channels[] | select(.name == \"${channel_name}\")" "$CONFIG_FILE"
}

load_peer_org_config() {
  local org_name="$1"
  "$YQ_BIN" eval ".peerOrgs[] | select(.name == \"$org_name\")" "$CONFIG_FILE"
}

load_orderer_org_config() {
  "$YQ_BIN" eval '.ordererOrg' "$CONFIG_FILE"
}

load_channels_config() {
  "$YQ_BIN" eval '.channels // []' "$CONFIG_FILE"
}

config_has_channels() {
  [[ "$("$YQ_BIN" -r 'has("channels")' "$CONFIG_FILE")" == "true" ]]
}

using_layered_config() {
  [[ "${CONFIG_SOURCE:-legacy}" == "layered" ]]
}

copy_msp_config() {
  local src_config="$1"     # 组织 MSP 下的 config.yaml
  local target_msp="$2"     # peer 或 user 的 MSP 目录

  mkdir -p "$target_msp"
  cp "$src_config" "$target_msp/config.yaml"
}
