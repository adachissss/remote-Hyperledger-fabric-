if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
: "${CONFIG_FILE:="${PROJECT_ROOT}/config/orgs.yaml"}"
source "${PROJECT_ROOT}/script/lib/fabric-ca-lib.sh"

# 读取 config/orgs.yaml 中的网络前缀
FABRIC_NET_PREFIX=$(get_config_value_raw '.network.env_prefix')

# 公网 IP
PUBLIC_IP="129.28.87.242"

# 生成连接配置文件
generate_connection_file() {
  local org_num=$1
  local org_name="Org${org_num}"
  local mspid="${org_name}MSP"
  local peer_host="${FABRIC_NET_PREFIX}-peer0.org${org_num}.example.com"
  local ca_host="ca.org${org_num}.example.com"
  local peer_port=$((7051 + (org_num - 1) * 1000))
  local ca_port=$((7054 + (org_num - 1) * 1000))
  local tls_ca_path="./tls-localhost-${ca_port}-ca-org${org_num}.pem"

  jq -n \
    --arg name "test-network-${org_name,,}" \
    --arg org "$org_name" \
    --arg mspid "$mspid" \
    --arg peer_host "$peer_host" \
    --arg ca_host "$ca_host" \
    --arg public_ip "$PUBLIC_IP" \
    --arg peer_port "$peer_port" \
    --arg ca_port "$ca_port" \
    --arg tls_ca_path "$tls_ca_path" \
    '{
      name: $name,
      version: "1.0.0",
      client: {
        organization: $org,
        connection: {
          timeout: {
            peer: {
              endorser: "100000"
            }
          }
        }
      },
      organizations: {
        ($org): {
          mspid: $mspid,
          peers: [$peer_host],
          certificateAuthorities: [$ca_host]
        }
      },
      peers: {
        ($peer_host): {
          url: ("grpcs://" + $public_ip + ":" + $peer_port),
          tlsCACerts: {
            path: $tls_ca_path
          },
          grpcOptions: {
            "ssl-target-name-override": $peer_host
          }
        }
      },
      certificateAuthorities: {
        ($ca_host): {
          url: ("https://" + $public_ip + ":" + $ca_port),
          caName: ("ca-" + ($org | ascii_downcase)),
          tlsCACerts: {
            path: $tls_ca_path
          },
          httpOptions: {
            verify: false
          }
        }
      }
    }' > "${PROJECT_ROOT}/${org_name,,}-connection.json"
}

# 生成 org1, org2, org3 的配置文件
for org in 1 2 3; do
  generate_connection_file $org
  success "已生成 ${PROJECT_ROOT}/org${org}-connection.json"
done

info "所有 connection 文件已生成到 ${PROJECT_ROOT}/"
