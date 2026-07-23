#!/usr/bin/env bash

PLUS_FABRIC_DEFAULT_FABRIC_VERSION="3.1.5"
PLUS_FABRIC_DEFAULT_FABRIC_CA_VERSION="1.5.21"

fabric_major_minor_version() {
  local version="$1"
  local major minor
  IFS='.' read -r major minor _ <<< "$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || {
    echo "无法解析 Fabric 版本: $version" >&2
    return 1
  }
  printf '%s.%s\n' "$major" "$minor"
}

fabric_chaincode_runtime_version() {
  local version="$1"
  local major_minor major
  major_minor="$(fabric_major_minor_version "$version")" || return 1
  major="${major_minor%%.*}"
  if (( major >= 3 )); then
    printf '2.5\n'
  else
    printf '%s\n' "$major_minor"
  fi
}
