#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd -P)}"
CONFIG_FILE="${CONFIG_FILE:-${PROJECT_ROOT}/config/orgs.yaml}"
STATUS="${1:-unknown}"

case "$STATUS" in
  configured|running|stopped|removed|unknown) ;;
  *)
    echo "不支持的网络发现状态: $STATUS" >&2
    exit 1
    ;;
esac

[[ -f "$CONFIG_FILE" ]] || {
  echo "找不到网络配置文件: $CONFIG_FILE" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "缺少依赖命令: jq" >&2
  exit 1
}

YQ_BIN="${YQ_BIN:-${PROJECT_ROOT}/bin/yq}"
[[ -x "$YQ_BIN" ]] || {
  echo "缺少可执行文件: $YQ_BIN" >&2
  exit 1
}

PROJECT_ROOT="$(realpath "$PROJECT_ROOT")"
CONFIG_FILE="$(realpath "$CONFIG_FILE")"
NETWORK_ID="$($YQ_BIN -r '.network.id // empty' "$CONFIG_FILE")"
DISPLAY_NAME="$($YQ_BIN -r '.network.display_name // .network.id // empty' "$CONFIG_FILE")"
DOCKER_NETWORK="$($YQ_BIN -r '.network.name // empty' "$CONFIG_FILE")"
CONFIGURED_COMPOSE_PROJECT="$($YQ_BIN -r '.network.compose_project // .network.id // empty' "$CONFIG_FILE")"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-$CONFIGURED_COMPOSE_PROJECT}"
FABRIC_VERSION="$($YQ_BIN -r '.network.fabric_version // empty' "$CONFIG_FILE")"
FABRIC_CA_VERSION="$($YQ_BIN -r '.network.fabric_ca_version // empty' "$CONFIG_FILE")"
PEER_ORGANIZATION_COUNT="$($YQ_BIN -r '[.peerOrgs[]?] | length' "$CONFIG_FILE")"
PEER_COUNT="$($YQ_BIN -r '[.peerOrgs[]?.peer_count] | add // 0' "$CONFIG_FILE")"
ORDERER_COUNT="$($YQ_BIN -r '[.ordererOrg.nodes[]?] | length' "$CONFIG_FILE")"
CHANNEL_COUNT="$($YQ_BIN -r '[.channels[]?] | length' "$CONFIG_FILE")"

[[ -n "$NETWORK_ID" && -n "$DISPLAY_NAME" && -n "$DOCKER_NETWORK" && -n "$COMPOSE_PROJECT" ]] || {
  echo "网络发现清单缺少 network id、名称、Docker network 或 Compose project" >&2
  exit 1
}

WORKSPACE_MANIFEST_DIR="${PROJECT_ROOT}/.plus-fabric"
DISCOVERY_ROOT="${PLUS_FABRIC_DISCOVERY_ROOT:-${HOME:-${PROJECT_ROOT}/runtime}/.plus-fabric/discovery/networks}"
WORKSPACE_MANIFEST="${WORKSPACE_MANIFEST_DIR}/network.json"
INDEX_MANIFEST="${DISCOVERY_ROOT}/${NETWORK_ID}.json"
MANIFEST_SOURCE=""
WORKSPACE_TEMPORARY_FILE=""
INDEX_TEMPORARY_FILE=""

cleanup() {
  rm -f "$MANIFEST_SOURCE" "$WORKSPACE_TEMPORARY_FILE" "$INDEX_TEMPORARY_FILE"
}

render_manifest() {
  local target="$1"
  jq -n \
    --argjson schemaVersion 1 \
    --arg networkId "$NETWORK_ID" \
    --arg displayName "$DISPLAY_NAME" \
    --arg status "$STATUS" \
    --arg workspaceRoot "$PROJECT_ROOT" \
    --arg configPath "$CONFIG_FILE" \
    --arg composeProject "$COMPOSE_PROJECT" \
    --arg dockerNetwork "$DOCKER_NETWORK" \
    --arg fabricVersion "$FABRIC_VERSION" \
    --arg fabricCaVersion "$FABRIC_CA_VERSION" \
    --argjson peerOrganizationCount "$PEER_ORGANIZATION_COUNT" \
    --argjson peerCount "$PEER_COUNT" \
    --argjson ordererCount "$ORDERER_COUNT" \
    --argjson channelCount "$CHANNEL_COUNT" \
    --arg updatedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    '{
      schemaVersion: $schemaVersion,
      networkId: $networkId,
      displayName: $displayName,
      source: "script",
      status: $status,
      workspaceRoot: $workspaceRoot,
      configPath: $configPath,
      composeProject: $composeProject,
      dockerNetwork: $dockerNetwork,
      fabricVersion: ($fabricVersion | if length > 0 then . else null end),
      fabricCaVersion: ($fabricCaVersion | if length > 0 then . else null end),
      summary: {
        peerOrganizationCount: $peerOrganizationCount,
        peerCount: $peerCount,
        ordererCount: $ordererCount,
        channelCount: $channelCount
      },
      updatedAt: $updatedAt
    }' > "$target"
  chmod 600 "$target"
}

stage_manifest() {
  local source="$1"
  local target="$2"
  local result_variable="$3"
  local temporary_file
  temporary_file="$(mktemp "${target}.tmp.XXXXXX")"
  cp "$source" "$temporary_file"
  chmod 600 "$temporary_file"
  printf -v "$result_variable" '%s' "$temporary_file"
}

umask 077
mkdir -p "$WORKSPACE_MANIFEST_DIR" "$DISCOVERY_ROOT"
trap cleanup EXIT

MANIFEST_SOURCE="$(mktemp "${WORKSPACE_MANIFEST_DIR}/network.json.source.XXXXXX")"
render_manifest "$MANIFEST_SOURCE"
stage_manifest "$MANIFEST_SOURCE" "$WORKSPACE_MANIFEST" WORKSPACE_TEMPORARY_FILE
stage_manifest "$MANIFEST_SOURCE" "$INDEX_MANIFEST" INDEX_TEMPORARY_FILE

mv "$WORKSPACE_TEMPORARY_FILE" "$WORKSPACE_MANIFEST"
WORKSPACE_TEMPORARY_FILE=""
mv "$INDEX_TEMPORARY_FILE" "$INDEX_MANIFEST"
INDEX_TEMPORARY_FILE=""
echo "$WORKSPACE_MANIFEST"
