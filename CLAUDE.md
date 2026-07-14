# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

This repository automates a local Hyperledger Fabric network. The main flow is:

1. `config/orgs.yaml` defines the network name/prefix, orderer organization, peer organizations, CA endpoints, MSP IDs, anchor peers, and admin passwords.
2. Scripts under `script/` generate Docker Compose files, Fabric certificates/MSPs, channel artifacts, peer `core.yaml` files, and host mappings from that config.
3. `network.sh` orchestrates network lifecycle commands over Docker Compose and Fabric CLI binaries in `bin/`.
4. Chaincode lives under `chaincode/`; `rsidentity-v1` provides enterprise identity and compliance checks, while `rsdata-v1` provides assets, licences, lineage, and private-data support.

Most scripts source `script/lib/fabric-ca-lib.sh`, which resolves configuration, exports `bin/` onto `PATH`, validates required Fabric binaries, and provides shared YAML/query/logging helpers. By default it normalizes the legacy `config/orgs.yaml`; it also has hooks for layered config files under `config/base`, `config/profiles`, and `config/local.override.yaml` if those files are introduced later.

## Common commands

### Network lifecycle

Run from the repository root:

```bash
./network.sh up        # generate compose/certs/channel artifacts, start CA/orderer/peer containers, join channel
./network.sh stop      # stop containers but keep volumes/certs/channel files
./network.sh restart   # start existing containers and refresh hosts mapping
./network.sh down      # stop containers and remove volumes, organizations/, and channel-artifacts/
```

`./network.sh down` is destructive for generated Fabric state. Do not run it unless the user explicitly wants the local network cleaned.

### Generate network config

```bash
./config/generate-orgs-config.sh \
  --network-name test-net \
  --env-prefix TESTNET \
  --peer-org-count 2 \
  --peers-per-org 2 \
  --orderer-count 3
```

This writes `config/orgs.yaml` by default and backs up an existing file to `config/orgs.yaml.bak`.

### Chaincode lifecycle

Install/approve/commit a Node chaincode package to all peer orgs from `config/orgs.yaml`:

```bash
./upgrade_chaincode.sh -n rsidentity -v 1.0.0 -s 1 -c mychannel -p ./chaincode/rsidentity-v1
```

Useful variants:

```bash
./upgrade_chaincode.sh -n rsdata -v 3.0.1 -s 1 -c mychannel -p ./chaincode/rsdata-v1 --collections-config ./chaincode/collections_config.json
```

Query or invoke chaincode:

```bash
./smart_contract_execute.sh mychannel rsidentity org1 query GetMyID
./smart_contract_execute.sh mychannel rsdata org1 query GetAllAssets 20 ""
```

The action argument must be `query` or `invoke`. JSON arguments should be passed as single-quoted shell arguments.

### Chaincode development

Run from `chaincode/rsdata-v1`:

```bash
npm install
npm test          # runs the Node.js PDC tests
npm start         # fabric-chaincode-node start
```

## Architecture notes

- `network.sh` is the top-level entry point. Its `up` path creates the configured Docker network, generates CA compose, starts CAs, enrolls peer/orderer identities, generates orderer/peer compose files, creates channel artifacts, starts peers/orderers, updates `/etc/hosts`, runs osnadmin, generates peer core files, and joins peers to the primary channel.
- `config/orgs.yaml` is the source of truth for the current topology. `config/configtx.yaml`, `docker/docker-compose-*.yaml`, `organizations/`, `channel-artifacts/`, and peer-specific `core.yaml` files are generated from it.
- `script/env.sh` centralizes channel/orderer environment variables such as `ORDERER_CA`, `ORDERER_ADDRESS`, `FABRIC_CFG_PATH`, `OSNADMIN_*`, and `CHANNEL_BLOCK`.
- `script/joinChannel.sh` discovers running peer containers with Docker, filters them to the configured channel member orgs, sets each peer's Fabric environment, and joins each peer to the channel block.
- `upgrade_chaincode.sh` uses Fabric lifecycle commands to package chaincode, install it for every peer org, approve definitions, check commit readiness, and commit with peer connection arguments for all orgs. If no signature policy is supplied, it builds an `OutOf(majority, '<MSP>.member', ...)` policy from configured peer orgs.
- `rsidentity-v1` must be deployed before `rsdata-v1`, because the data contract invokes the `rsidentity` chaincode for compliance checks and transaction counters.
- `rsdata-v1` stores CID and sensitive metadata in `rsAssetPrivateDataCollection`; its collection policy permits Org1 and Org2 and requires both organizations for collection endorsement.

## Tooling and dependencies

- Fabric CLI binaries are expected in `bin/` (`peer`, `configtxgen`, `fabric-ca-client`, `osnadmin`, etc.) and are installed locally with `script/install-fabric-tools.sh`; downloaded binaries are not version-controlled.
- The scripts expect Docker Compose, `nc`, `python3`, and `bin/yq` to be available. `script/lib/fabric-ca-lib.sh` exits early when required Fabric binaries or `yq` are missing.
- Many shell scripts use `set -euo pipefail`; preserve that behavior when editing them.
- Shell output and user-facing script messages are mostly Chinese; keep that style when modifying existing scripts.

## Generated state and caution areas

- Treat `organizations/`, `channel-artifacts/`, generated `docker/docker-compose-*.yaml`, and generated peer/orderer YAML as reproducible local network state unless the user says otherwise.
- Several scripts modify host mappings and use Docker state. Confirm before running commands that affect `/etc/hosts`, Docker volumes, or generated network state.
