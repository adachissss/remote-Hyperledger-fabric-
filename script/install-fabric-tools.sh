#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="${PROJECT_ROOT}/bin"

FABRIC_VERSION="3.1.5"
FABRIC_CA_VERSION="1.5.21"
FABRIC_SHA256="b9c31fd490991e76f8acb1835dee09fc19fee5428cb13e190ee6e0bdd2c37858"
FABRIC_CA_SHA256="a599e8e9d57aede74b9e1ba2bcdbb679957a877f2952c3ae3e2260df63240165"
DOWNLOAD_BASE="https://github.com/hyperledger"

command -v curl >/dev/null 2>&1 || {
  echo "缺少依赖命令: curl" >&2
  exit 1
}
command -v tar >/dev/null 2>&1 || {
  echo "缺少依赖命令: tar" >&2
  exit 1
}
command -v sha256sum >/dev/null 2>&1 || {
  echo "缺少依赖命令: sha256sum" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) platform="linux" ;;
  *)
    echo "当前安装脚本仅支持 Linux amd64" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="amd64" ;;
  *)
    echo "Fabric ${FABRIC_VERSION} 官方归档不支持当前架构: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/plus-fabric-tools.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

download_and_install() {
  local project="$1"
  local version="$2"
  local archive_name="$3"
  local expected_sha256="$4"
  local url="${DOWNLOAD_BASE}/${project}/releases/download/v${version}/${archive_name}"
  local archive_path="${tmp_dir}/${archive_name}"
  local extract_dir="${tmp_dir}/${project}"

  echo "下载 ${project} v${version}: ${url}"
  curl --fail --location --retry 3 --output "$archive_path" "$url"

  local actual_sha256
  actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
  [[ "$actual_sha256" == "$expected_sha256" ]] || {
    echo "SHA-256 校验失败: ${archive_name}" >&2
    echo "期望: ${expected_sha256}" >&2
    echo "实际: ${actual_sha256}" >&2
    exit 1
  }

  mkdir -p "$extract_dir"
  tar -xzf "$archive_path" -C "$extract_dir"

  [[ -d "${extract_dir}/bin" ]] || {
    echo "归档中未找到 bin 目录: ${archive_name}" >&2
    exit 1
  }

  find "${extract_dir}/bin" -maxdepth 1 -type f -print0 \
    | while IFS= read -r -d '' binary; do
        install -m 0755 "$binary" "${BIN_DIR}/$(basename "$binary")"
      done
}

mkdir -p "$BIN_DIR"

fabric_archive="hyperledger-fabric-${platform}-${arch}-${FABRIC_VERSION}.tar.gz"
fabric_ca_archive="hyperledger-fabric-ca-${platform}-${arch}-${FABRIC_CA_VERSION}.tar.gz"

download_and_install "fabric" "$FABRIC_VERSION" "$fabric_archive" "$FABRIC_SHA256"
download_and_install "fabric-ca" "$FABRIC_CA_VERSION" "$fabric_ca_archive" "$FABRIC_CA_SHA256"

echo "Fabric 工具已安装到 ${BIN_DIR}"
"${BIN_DIR}/peer" version
"${BIN_DIR}/fabric-ca-client" version
