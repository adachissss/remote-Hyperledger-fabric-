# plus-fabric

本项目使用 Bash、Docker Compose 和 Hyperledger Fabric CLI 自动生成并运行一个三组织、三 Orderer 的本地 Fabric 网络。业务链码位于 `chaincode/rsidentity-v1` 和 `chaincode/rsdata-v1`。

仓库同时正在建设一个通用的多网络 Fabric Control Plane。它不预置任何网络实例或链码，架构和迭代计划见：

- `docs/control-plane-architecture.md`
- `docs/control-plane-roadmap.md`

## Control Plane 开发

Control Plane 使用 pnpm workspace、Fastify、React 和共享 TypeScript schema：

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

当前 foundation milestone 的网络注册表有意保持为空，不会把仓库中的 Fabric 工作目录自动注册为平台实例。

## 仓库边界

Git 只保存项目源码、脚本、模板和示例配置。以下内容均在本机生成，不应提交：

- Fabric/CA 第三方二进制和 Node.js `node_modules`；
- `organizations/` 中的证书、私钥、MSP 和 CA 数据库；
- `channel-artifacts/`、动态 `configtx.yaml` 和 Docker Compose 文件；
- 链码安装包、连接配置、日志和备份文件。

清理 Git 不会删除这些本地运行数据。`./network.sh down` 才会删除 Fabric 卷、组织材料和通道文件。

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

## 网络生命周期

所有命令都从仓库根目录执行：

```bash
./network.sh up       # 首次生成并启动网络
./network.sh stop     # 暂停容器，保留全部状态
./network.sh restart  # 恢复已有容器和账本
./network.sh down     # 删除容器卷、组织材料和通道文件
```

`up` 会依次生成 CA、组织证书、Compose、通道配置和 Peer `core.yaml`，再启动节点并加入 `mychannel`。

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
