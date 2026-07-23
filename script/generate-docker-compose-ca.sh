#!/bin/bash
# 根据配置生成 docker/docker-compose-ca.yaml

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"

source "${SCRIPT_DIR}/lib/fabric-ca-lib.sh"
source "${SCRIPT_DIR}/lib/fabric-version.sh"

OUTPUT_FILE="${PROJECT_ROOT}/docker/docker-compose-ca.yaml"
CA_INTERNAL_PORT=7054
CA_PORT_BASE_START=7000
CA_PORT_STRIDE=1000
CA_PORT_OFFSET=54
ORDERER_CA_DEFAULT_PORT=10054

extract_port_from_url() {
  local url="$1"
  if [[ "$url" =~ :([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

get_default_peer_ca_port() {
  local index="$1"
  echo $((CA_PORT_BASE_START + index * CA_PORT_STRIDE + CA_PORT_OFFSET))
}

get_peer_ca_host_port() {
  local org_name="$1"
  local org_index="$2"
  local explicit_port="$3"
  local ca_url="$4"

  if [[ -n "$explicit_port" && "$explicit_port" != "null" ]]; then
    echo "$explicit_port"
    return 0
  fi

  if extract_port_from_url "$ca_url" >/dev/null; then
    extract_port_from_url "$ca_url"
    return 0
  fi

  get_default_peer_ca_port "$org_index"
}

get_orderer_ca_host_port() {
  local explicit_port="$1"
  local ca_url="$2"
  local peer_org_count="$3"

  if [[ -n "$explicit_port" && "$explicit_port" != "null" ]]; then
    echo "$explicit_port"
    return 0
  fi

  if extract_port_from_url "$ca_url" >/dev/null; then
    extract_port_from_url "$ca_url"
    return 0
  fi

  echo $((CA_PORT_BASE_START + peer_org_count * CA_PORT_STRIDE + CA_PORT_OFFSET))
}

write_ca_service() {
  local service_name="$1"
  local container_name="$2"
  local ca_name="$3"
  local host_port="$4"
  local volume_dir="$5"
  local bootstrap_password="$6"
  local organization="$7"

  cat >> "$OUTPUT_FILE" <<EOF
  ${service_name}:
    image: hyperledger/fabric-ca:${FABRIC_CA_IMAGE_TAG}
    container_name: ${container_name}
    labels:
      com.plus-fabric.network.id: "${FABRIC_NET_ID}"
      com.plus-fabric.compose-project: "${COMPOSE_PROJECT_NAME}"
      com.plus-fabric.role: "ca"
      com.plus-fabric.organization: "${organization}"
      com.plus-fabric.node: "${container_name}"
    ports:
      - "${host_port}:${CA_INTERNAL_PORT}"
    environment:
      - FABRIC_CA_HOME=/etc/hyperledger/fabric-ca-server
      - FABRIC_CA_SERVER_CA_NAME=${ca_name}
      - FABRIC_CA_SERVER_PORT=${CA_INTERNAL_PORT}
      - FABRIC_CA_SERVER_TLS_ENABLED=true
    volumes:
      - ${volume_dir}:/etc/hyperledger/fabric-ca-server
    command: sh -c 'fabric-ca-server start -b admin:${bootstrap_password} --port ${CA_INTERNAL_PORT} --tls.enabled'
    networks:
      - ${FABRIC_DOCKER_NET}
EOF
}

FABRIC_DOCKER_NET=$(get_config_value_raw '.network.name')
FABRIC_NET_ID=$(get_config_value_raw '.network.id')
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(get_config_value_raw '.network.compose_project // .network.id')}"
FABRIC_CA_IMAGE_TAG=$(get_config_value_raw ".network.fabric_ca_version // \"${PLUS_FABRIC_DEFAULT_FABRIC_CA_VERSION}\"")
NAMESPACE_CONTAINERS=$(get_config_value_raw '.network.namespace_containers // false')
if [[ "$NAMESPACE_CONTAINERS" == "true" ]]; then
  CA_CONTAINER_PREFIX="${FABRIC_NET_PREFIX}-"
else
  CA_CONTAINER_PREFIX=""
fi
mapfile -t PEER_ORGS < <(get_peer_org_names)
ORDERER_CONFIG=$(load_orderer_org_config)
ORDERER_CA_NAME=$(printf '%s' "$ORDERER_CONFIG" | "$YQ_BIN" -r '.ca_name')
ORDERER_CA_URL=$(printf '%s' "$ORDERER_CONFIG" | "$YQ_BIN" -r '.ca_url // empty')
ORDERER_CA_PORT_OVERRIDE=$(printf '%s' "$ORDERER_CONFIG" | "$YQ_BIN" -r '.ca_port // empty')

# 按 config/orgs.yaml 动态生成 fabric-ca-server-config.yaml
generate_ca_server_config() {
  local ca_dir="$1"
  local ca_name="$2"
  local ca_port="$3"
  local bootstrap_password="$4"

  mkdir -p "$ca_dir"

  # 构建 affiliations YAML
  local affiliations_yaml="affiliations:"
  local affiliation_org
  for affiliation_org in "${PEER_ORGS[@]}"; do
    affiliations_yaml+=$'\n'"   ${affiliation_org}:"
    affiliations_yaml+=$'\n'"      - department1"
    affiliations_yaml+=$'\n'"      - department2"
  done

  cat > "${ca_dir}/fabric-ca-server-config.yaml" <<YAML_EOF
version: ${FABRIC_CA_IMAGE_TAG}
port: ${ca_port}
debug: false
crlsizelimit: 512000

tls:
  enabled: true
  certfile:
  keyfile:
  clientauth:
    type: noclientcert
    certfiles:

ca:
  name: ${ca_name}
  keyfile:
  certfile:
  chainfile:

crl:
  expiry: 24h

registry:
  maxenrollments: -1
  identities:
     - name: admin
       pass: ${bootstrap_password}
       type: client
       affiliation: ""
       attrs:
          hf.Registrar.Roles: "*"
          hf.Registrar.DelegateRoles: "*"
          hf.Revoker: true
          hf.IntermediateCA: true
          hf.GenCRL: true
          hf.Registrar.Attributes: "*"
          hf.AffiliationMgr: true

db:
  type: sqlite3
  datasource: fabric-ca-server.db
  tls:
      enabled: false
      certfiles:
      client:
        certfile:
        keyfile:

ldap:
   enabled: false
   url: ldap://<adminDN>:<adminPassword>@<host>:<port>/<base>
   tls:
      certfiles:
      client:
         certfile:
         keyfile:

${affiliations_yaml}

signing:
    default:
      usage:
        - digital signature
      expiry: 8760h
    profiles:
      ca:
         usage:
           - cert sign
           - crl sign
         expiry: 43800h
         caconstraint:
           isca: true
           maxpathlen: 0
      tls:
         usage:
            - signing
            - key encipherment
            - server auth
            - client auth
            - key agreement
         expiry: 8760h

csr:
   cn: fabric-ca-server
   keyrequest:
     algo: ecdsa
     size: 256
   names:
      - C: US
        ST: "North Carolina"
        L:
        O: Hyperledger
        OU: Fabric
   hosts:
     - localhost
   ca:
      expiry: 131400h
      pathlength: 1

idemix:
  rhpoolsize: 1000
  nonceexpiration: 15s
  noncesweepinterval: 15m

bccsp:
    default: SW
    sw:
        hash: SHA2
        security: 256
        filekeystore:
            keystore: msp/keystore

cfg:
  identities:
    passwordattempts: 10
YAML_EOF

  info "CA 服务端配置已生成: ${ca_dir}/fabric-ca-server-config.yaml"
}

cat > "$OUTPUT_FILE" <<EOF
services:
EOF

for org in "${PEER_ORGS[@]}"; do
  ORG_CONFIG=$(load_peer_org_config "$org")
  ORG_INDEX=$(get_peer_org_index "$org")
  CA_NAME=$(printf '%s' "$ORG_CONFIG" | "$YQ_BIN" -r '.ca_name')
  CA_URL=$(printf '%s' "$ORG_CONFIG" | "$YQ_BIN" -r '.ca_url // empty')
  CA_PORT_OVERRIDE=$(printf '%s' "$ORG_CONFIG" | "$YQ_BIN" -r '.ca_port // empty')
  ADMIN_PASSWORD=$(printf '%s' "$ORG_CONFIG" | "$YQ_BIN" -r '.admin_password // "adminpw"')
  HOST_PORT=$(get_peer_ca_host_port "$org" "$ORG_INDEX" "$CA_PORT_OVERRIDE" "$CA_URL")

  generate_ca_server_config \
    "${PROJECT_ROOT}/organizations/fabric-ca/${org}" \
    "$CA_NAME" \
    "$CA_INTERNAL_PORT" \
    "$ADMIN_PASSWORD"

  write_ca_service \
    "${CA_CONTAINER_PREFIX}ca_${org}" \
    "${CA_CONTAINER_PREFIX}ca_${org}" \
    "$CA_NAME" \
    "$HOST_PORT" \
    "../organizations/fabric-ca/${org}" \
    "$ADMIN_PASSWORD" \
    "$org"
done

ORDERER_CA_HOST_PORT=$(get_orderer_ca_host_port "$ORDERER_CA_PORT_OVERRIDE" "$ORDERER_CA_URL" "${#PEER_ORGS[@]}")
ORDERER_ADMIN_PASSWORD=$(printf '%s' "$ORDERER_CONFIG" | "$YQ_BIN" -r '.admin_password // "adminpw"')

generate_ca_server_config \
  "${PROJECT_ROOT}/organizations/fabric-ca/ca-orderer" \
  "$ORDERER_CA_NAME" \
  "$CA_INTERNAL_PORT" \
  "$ORDERER_ADMIN_PASSWORD"

write_ca_service \
  "${CA_CONTAINER_PREFIX}ca_orderer" \
  "${CA_CONTAINER_PREFIX}ca_orderer" \
  "$ORDERER_CA_NAME" \
  "$ORDERER_CA_HOST_PORT" \
  "../organizations/fabric-ca/ca-orderer" \
  "$ORDERER_ADMIN_PASSWORD" \
  "orderer"

cat >> "$OUTPUT_FILE" <<EOF
networks:
  ${FABRIC_DOCKER_NET}:
    external: true
EOF

log_success "\nCA compose 生成完成！"
success "   输出文件: $OUTPUT_FILE"
success "   Peer 组织 CA 数量: ${#PEER_ORGS[@]}"
success "   Orderer CA 端口: ${ORDERER_CA_HOST_PORT}"
info "=================================================="
