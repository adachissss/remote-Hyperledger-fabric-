# Web / CLI 双入口、单引擎设计

## 1. 目标

让 Web 控制台和终端 CLI 共享同一套网络配置生成、端口规划、工作区隔离、作业互斥、日志和 Fabric 驱动能力。终端不应成为 Web 的简化副本，也不应重新实现一套网络编排逻辑。

原始 `network.sh` 继续作为可独立运行的底层驱动。控制平面不可用时，用户仍能进入网络工作区直接执行脚本；控制平面恢复后，可以发现并导入这些 CLI 网络。

## 2. 架构决策

```text
React Web ─────┐
               ├─ REST / SSE ─ Fastify Control Plane ─ Job Service ─ network.sh
pfctl CLI ─────┘                       │
                                      ├─ Managed config builder
                                      ├─ Port planner
                                      ├─ Network registry
                                      └─ SQLite job history

Direct shell ─────────────────────────────────────────────── network.sh
                                                                  │
                                                                  └─ discovery manifest / Docker labels
```

第一阶段的 `pfctl` 是现有控制平面的正式客户端：

- 创建请求继续使用 `CreateManagedNetworkRequestSchema`；
- 导入请求继续使用 `ImportNetworkRequestSchema`；
- 生命周期操作继续创建现有 Job；
- 日志继续使用 JobEvent 和 SSE；
- CLI 不自行分配端口、不直接生成 `orgs.yaml`、不绕过网络级互斥锁；
- CLI 的非交互输出支持 JSON，便于脚本和后续自动化使用。

直接执行 `network.sh` 时不要求 API 存在。脚本只写入标准发现清单并为 Docker 资源增加归属标签，不主动修改控制平面数据库。

## 3. CLI 范围

命令名称为 `pfctl`，默认 API 地址为 `http://127.0.0.1:4100`，可通过 `--api` 或 `PLUS_FABRIC_API_URL` 覆盖。

第一阶段命令：

```text
pfctl health
pfctl network list
pfctl network create --file <yaml-or-json>
pfctl network import --file <yaml-or-json>
pfctl network up <network-id> [--detach]
pfctl network stop <network-id> [--detach]
pfctl network restart <network-id> [--detach]
pfctl network down <network-id> --yes [--detach]
pfctl network delete <network-id> --yes [--detach]
pfctl job list [--network <network-id>]
pfctl job get <job-id>
pfctl job follow <job-id>
pfctl job cancel <job-id>
```

默认生命周期命令会跟随作业直到终态；`--detach` 只输出 Job ID。终态退出码：

- `succeeded`：0；
- `failed`：1；
- `cancelled`：2；
- 参数、连接或协议错误：3。

SSE 本身没有关闭事件，因此 CLI 需要同时以 Job 查询结果作为终态事实来源。断线后使用最后一个事件 ID 重放，避免日志缺失或重复。

## 4. CLI 配置文件

`network create --file` 直接接受现有 managed network 请求模型。YAML 和 JSON 只是序列化形式不同，不引入第二套配置 schema。

配置文件是创建请求，不是 Fabric driver 最终配置。控制平面仍负责生成：

```text
runtime/networks/<network-id>/config/orgs.yaml
```

这样 Web 创建和 CLI 创建得到完全相同的工作区内容。

## 5. 直接脚本发现协议

每个网络工作区写入：

```text
<workspace>/.plus-fabric/network.json
```

同时写入当前用户的发现索引：

```text
${PLUS_FABRIC_DISCOVERY_ROOT:-$HOME/.plus-fabric/discovery/networks}/<network-id>.json
```

发现清单只包含定位和观测所需字段：

```ts
type NetworkDiscoveryManifest = {
  schemaVersion: 1;
  networkId: string;
  displayName: string;
  source: 'script';
  status: 'configured' | 'running' | 'stopped' | 'removed' | 'unknown';
  workspaceRoot: string;
  configPath: string;
  composeProject: string;
  dockerNetwork: string;
  fabricVersion: string;
  fabricCaVersion: string;
  updatedAt: string;
};
```

清单不得包含 CA 密码、私钥、MSP 内容、transient 数据或链码参数。写入使用临时文件后原子替换，避免脚本中断留下半份 JSON。

脚本状态变化：

- `up` 成功后写 `running`；
- `stop` 成功后写 `stopped`；
- `restart` 成功后写 `running`；
- `down` 成功后写 `removed`，保留痕迹供 Web 识别历史工作区；
- 失败不覆盖最后一个成功状态，另写 `lastErrorAt` 属于后续增强。

## 6. Docker 归属标签

CA、Peer、Orderer 和 CouchDB 服务统一增加：

```text
com.plus-fabric.network.id
com.plus-fabric.compose-project
com.plus-fabric.role
com.plus-fabric.organization
com.plus-fabric.node
```

Docker Network 和显式 Volume 至少增加 network ID 与 Compose Project 标签。现有 Compose Project 标签仍是清理资源的主要依据，新标签用于发现、核验和错误诊断。

不同 Docker Network 不能避免宿主机发布端口冲突；通过 CLI 调用控制平面时继续复用现有端口规划，直接脚本启动时由启动前预检和 Docker Compose 最终校验共同处理。

## 7. Web 发现流程

发现和注册是两个状态：

1. API 扫描发现根目录中的合法清单；
2. 与 Network Registry 按 ID、工作区和 Compose Project 去重；
3. Web 展示“待导入”“已注册”“痕迹失效”；
4. 用户确认后才进入现有 import 流程；
5. 导入时重新读取配置并核验真实路径、Docker Network、Compose Project 和端口；
6. 不自动执行发现工作区中的脚本。

第一阶段只自动发现本项目脚本写出的标准清单。任意第三方 Fabric 网络仍可使用手工导入，后续再增加 Docker 标签和 Compose Project 的启发式扫描。

## 8. 提交与验收拆分

每个阶段保持独立提交：

1. 架构决策和命令契约；
2. `pfctl` 基础包、API 客户端和输出模型；
3. 网络创建、导入、查询和生命周期命令；
4. 作业实时跟随、取消和退出码；
5. 脚本发现清单与 Docker 标签；
6. 发现 API 和 Web 导入入口；
7. 文档、回归测试和体验修正。

阶段性验收：

- 同一份创建请求从 Web 或 CLI 提交，生成的工作区结构一致；
- CLI 启动作业立即出现在 Web 作业列表，Web 启动作业也能由 CLI 跟随；
- 同一网络的 Web/CLI 并发操作继续被数据库互斥锁拒绝；
- `network.sh` 在 API 停止时仍可独立使用；
- 脚本启动的网络可被 Web 发现，但必须由用户确认后注册；
- 所有操作保持多网络工作区、Compose Project、Docker Network 和端口隔离；
- `pnpm check`、Shell 语法检查和 CLI 集成测试全部通过。

## 9. 非目标

本阶段不实现：

- CLI 内复制后端配置生成器或端口规划器；
- 自动接管所有宿主机 Fabric 容器；
- 无确认自动注册或执行发现到的外部工作区；
- Kubernetes、远程多主机执行和多租户权限系统；
- Caliper 测试执行。
