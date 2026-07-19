# plus-fabric

本项目使用 Bash、Docker Compose 和 Hyperledger Fabric CLI 自动生成并运行一个三组织、三 Orderer 的本地 Fabric 网络。业务链码位于 `chaincode/rsidentity-v1` 和 `chaincode/rsdata-v1`。

仓库同时包含一个通用的多网络 Fabric Control Plane。它不预置任何网络实例或链码，架构和迭代计划见：

- `docs/control-plane-architecture.md`
- `docs/control-plane-roadmap.md`

## Control Plane 开发

Control Plane 使用 pnpm workspace、Fastify、React 和共享 TypeScript schema。开发环境需要 Node.js 22 和 pnpm 10：

```bash
pnpm install
pnpm dev
```

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4100`
- Health: `http://127.0.0.1:4100/api/v1/system/health`

完整验证：

```bash
pnpm check
```

网络注册表默认从空状态启动，不会把仓库或宿主机上的网络自动注册为平台实例。SQLite 数据默认保存在 `runtime/control-plane/control-plane.sqlite`，该目录不会提交到 Git。

导入已有网络前，管理员必须显式允许服务端工作区根目录；多个根目录使用逗号分隔：

```bash
CONTROL_PLANE_ALLOWED_NETWORK_ROOTS=/srv/fabric-networks,/opt/fabric-workspaces pnpm dev
```

控制台只接受允许目录内的真实路径和相对配置路径。未设置该变量时，浏览和健康检查仍可使用，但导入 API 会返回 `403`。

导入包含可执行 `network.sh` 的工作区后，可以从网络详情的“运维”页面执行 `up`、`stop`、`restart` 和 `down`。控制平面会继续调用原脚本，并使用注册时保存的工作区、配置文件和 Compose project；原有命令行方式不受影响。作业步骤、退出码和实时日志保存在本地 SQLite 中，同一网络不会并发执行两个生命周期操作。

`down` 只会删除目标网络工作区对应的 Compose 容器、Fabric 链码构建/运行容器、卷、组织材料、通道产物、Docker network 和分段 `/etc/hosts` 映射，不会清理其他已注册网络；网页端需要输入网络 ID 确认。如果目标网络仍被容器占用，作业会明确失败，不再静默跳过。也可以继续进入该网络工作区直接执行 `./network.sh down`。

运维页面还提供独立的“彻底删除网络”：它先执行上述 `down`，并清理目标网络的链码构建镜像；成功后释放 SQLite 注册记录和宿主机端口。平台管理的网络还会删除 `runtime/networks/<network-id>` 工作区；导入网络只从控制平面注销，外部工作区保持不变。删除作业完成后仍保留历史日志，便于核对清理结果。

网络运行后，可以从网络详情的“账本”页面动态发现 Peer 已加入的通道、查看账本高度、分页浏览历史区块，并展开交易明文。后端通过 Peer QSCC 读取最终提交的区块，使用 `fabric-protos` 递归解析交易验证结果、Creator、链码函数与参数、背书、响应、事件和公共读写集。JSON/UTF-8 值提供明文与 base64 原值双视图；transient 数据和私有集合明文不在公共区块中，页面只展示可验证的私有集合哈希摘要。

当前 Control Plane 已实现：

- 创建或导入多个异名 Fabric 网络，并为托管网络自定义 Peer 组织数量、每组织 Peer 数、Orderer 数量、多个通道及通道成员；
- 托管网络可选择默认 LevelDB 或为每个 Peer 配套独立 CouchDB 容器、数据卷和监视节点；
- Orderer 可选择 Raft 或单节点实验 Solo，并自定义批次超时、最大交易数和区块批次大小；
- 托管网络独立工作区、Docker network、Compose project、容器/卷命名空间和宿主机端口规划；
- 多网络注册、配置、拓扑和节点运行状态查看；
- `network.sh` 生命周期作业、SQLite 记录、SSE 实时日志、取消和网络级互斥；
- 目标化网络清理与彻底删除，回收链码残留容器、Docker network、注册端口和托管工作区；
- 动态通道发现、账本高度、区块分页和 Fabric protobuf 明文解析；
- 已安装包与已提交链码清单、通用部署作业以及 evaluate/submit 执行台；
- 默认简体中文的亮色 Web 控制台。

在“网络”页面点击“创建网络”即可配置基础拓扑、状态数据库和 Orderer 出块策略。LevelDB 不增加额外容器；选择 CouchDB 后，每个 Peer 会获得独立 CouchDB service、持久化卷、健康检查和宿主机端口，并出现在拓扑与节点状态页面。Orderer 默认使用 Raft；Solo 仅允许 Fabric 2.x 的单 Orderer 本地实验网络。批次超时、最大交易数、绝对大小上限和首选大小上限会写入实际通道配置块。端口可以由平台自动寻找连续可用区间，也可以指定起始端口；创建时会同时检查注册表保留端口和宿主机监听端口。多网络仍通过独立 Docker network、Compose project、容器/卷命名空间和宿主机端口共同隔离。

托管网络默认生成到 `runtime/networks/<network-id>`，工作区就是文件隔离边界：配置、证书、通道产物和动态 Compose 文件均生成在各自目录内。工作区只复制运行所需的脚本白名单，不会把源码目录中的 `.bk`、临时 `core.yaml` 等备份或生成物带入新网络；Fabric CLI 二进制作为共享工具链挂入。默认使用 Fabric `2.4.1` 和 Fabric CA `1.5.3`，创建时可以为每个网络显式覆盖版本；必须使用明确的语义版本，不能使用会漂移的 `latest`。

网页创建完成后仍可进入对应工作区直接使用原脚本：

```bash
cd runtime/networks/<network-id>
./network.sh up
```

网页“运维”页面调用的也是该工作区中的 `network.sh`，脚本式入口不会被替换。创建网络只生成配置和工作区，不会自动启动容器。

链码部署从已注册网络工作区内的相对源码路径读取，不预置示例链码。部署继续调用工作区原有的 `upgrade_chaincode.sh`，日志、取消、超时和网络互斥沿用统一作业系统；命令行入口不受影响。当前部署过程记录为单个脚本步骤，后续再拆分为可独立重试的 package/install/approve/readiness/commit 结构化步骤。

PDC 属于链码 collections 配置，而不是网络拓扑字段；当前继续在链码部署时按网络工作区内的 collections JSON 配置。更多 Raft 细节和节点级启动参数将在后续拓扑版本中逐步开放。

Caliper 仍暂缓。

## 仓库边界

Git 只保存项目源码、脚本、模板和示例配置。以下内容均在本机生成，不应提交：

- Fabric/CA 第三方二进制和 Node.js `node_modules`；
- `organizations/` 中的证书、私钥、MSP 和 CA 数据库；
- `channel-artifacts/`、动态 `configtx.yaml` 和 Docker Compose 文件；
- 链码安装包、连接配置、日志和备份文件。

清理 Git 不会删除这些本地运行数据。`./network.sh down` 才会删除当前工作区对应的 Fabric 容器、卷、Docker network、组织材料、通道文件和 hosts 映射。

## 首次准备

需要 Docker、Docker Compose、`curl`、`jq`、`nc`、Python 3，以及系统 `yq`。项目中的 `bin/yq` 是兼容包装器。

下载固定版本的 Fabric 2.4.1 和 Fabric CA 1.5.3 CLI：

```bash
./script/install-fabric-tools.sh
```

创建本机拓扑配置并修改其中的示例密码：

```bash
cp config/orgs.example.yaml config/orgs.yaml
```

## 仓库根目录网络生命周期

仓库原有的单网络配置仍可从仓库根目录执行：

```bash
./network.sh up       # 首次生成并启动网络
./network.sh stop     # 暂停容器，保留全部状态
./network.sh restart  # 恢复已有容器和账本
./network.sh down     # 删除本网络容器、卷、Docker network、组织材料和通道文件
```

`up` 会依次生成 CA、组织证书、Compose、通道配置和 Peer `core.yaml`，再启动节点并将配置中的 Orderer 与 Peer 加入各自通道。

托管网络则从各自的 `runtime/networks/<network-id>` 工作区执行同一组命令。`network.sh` 会以脚本所在目录作为工作区，默认拒绝读取工作区外的配置；仅在明确需要兼容外部配置时才可设置 `ALLOW_EXTERNAL_CONFIG_FILE=true`。

## 链码

先部署身份链码，再部署依赖它的数据链码：

```bash
./upgrade_chaincode.sh -n rsidentity -v 1.0.0 -s 1 -c mychannel \
  -p ./chaincode/rsidentity-v1

./upgrade_chaincode.sh -n rsdata -v 3.0.1 -s 1 -c mychannel \
  -p ./chaincode/rsdata-v1 \
  --collections-config ./chaincode/collections_config.json
```

调用示例：

```bash
./smart_contract_execute.sh mychannel rsidentity org1 query GetMyID
```
