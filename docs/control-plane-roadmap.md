# Fabric Control Plane Roadmap

## Phase 0 — Foundation

目标：形成可维护的工程边界和可运行空壳。

- [x] 明确架构、API 边界和安全边界；
- [x] 建立 pnpm workspace；
- [x] 建立 `apps/api`、`apps/web`、`packages/shared`；
- [x] 建立 `apps/cli`，让终端入口复用共享 schema 和控制平面 API；
- [x] 定义通用 Network Registry、Network Driver 和 Chaincode Catalog 接口；
- [x] API/Web health check；
- [x] 环境配置校验、统一 test/typecheck/build；
- [x] 为 runtime 数据增加忽略规则。

验收：`pnpm dev` 能同时启动 API 和 Web；`pnpm typecheck`、`pnpm build` 通过。

## Phase 1 — Read-only Network Observatory

目标：不改变 Fabric 状态即可同时观察多个异名 Fabric 网络。

- [x] SQLite 持久化空网络注册表，不自动注入默认实例；
- [x] 从管理员允许的服务端工作区导入多个网络；
- [x] 创建由平台管理的网络；
- [x] 网络配置、拓扑和节点 API/路由以 `networkId` 为第一维；
- [x] 解析每个网络脱敏后的配置；
- [x] 后端直接解析 `config/orgs.yaml`、Compose 配置与 Docker 状态，无需依赖文本导出脚本；
- [x] Docker 容器状态、镜像、IP、端口和时间；
- [x] Peer、Orderer 与 CA 主服务端口的 TCP 可达性探测及降级展示；
- [x] Fleet Overview、URL 驱动的 Network Selector、Topology 和 Nodes 页面；
- [x] Configuration 页面；
- [x] 定时刷新和错误降级展示。

验收：至少两个名称和拓扑不同的网络可以同时注册；停止和运行状态均能正确展示，不串用配置、容器或凭据，也不返回密码和私钥。

## Phase 2 — Operations and Live Logs

目标：将网络生命周期变成可观察的异步作业。

- [x] Job/JobStep/JobEvent 数据模型与 SQLite 持久化；
- [x] managed network 独立工作区、Compose project、Docker network、文件生成边界和端口冲突检查；
- [x] 自定义 Peer 组织数、每组织 Peer 数、Orderer 数、多通道和通道成员；
- [x] Web 中文创建向导、自动端口规划和指定起始端口；
- [x] 可选 CouchDB 状态数据库、每 Peer 独立数据卷、端口规划及 CouchDB 节点拓扑；
- [x] etcdraft/Solo 共识约束及 BatchSize/BatchTimeout 参数；
- [ ] Raft 细节、日志级别和更多节点启动参数；
- [x] 按注册工作区、配置路径和 Compose project 调用原脚本，并保留原脚本命令入口；
- [x] 无 Shell 拼接的子进程执行器与基础日志脱敏；
- [x] SSE 实时日志与历史事件重放；
- [x] up、stop、restart；
- [x] 带网络 ID 确认的 down，只清理目标网络的容器、卷、Docker network、hosts 映射和工作区运行产物；
- [x] 彻底删除网络，回收链码 builder/runtime 残留、注册端口和 managed workspace，保留 imported workspace 与作业历史；
- [x] 网络级锁、超时、取消、异常重启恢复和本地作业记录；
- [x] Operations 页面、步骤状态与实时日志控制台。
- [x] `pfctl` 网络创建、导入、查询、生命周期和作业命令，支持 YAML/JSON、`--json` 与 `--detach`；
- [x] CLI 通过 SSE 与 JSON 历史共同跟随作业，支持事件去重、断线补偿、有限重试和终态退出码；
- [x] `network.sh` 成功状态写入工作区/用户双份发现清单，并为网络、节点和卷增加归属标签；
- [x] Web/CLI 展示本地脚本发现状态，并经用户确认导入；普通手工导入继续受 allowed roots 约束；

验收：浏览器发起部署后可以看到完整步骤、实时日志和最终状态；重复点击不会并发破坏同一网络。

## Phase 3 — Ledger Explorer

目标：实现可核验的区块和交易解析。

- [x] 从实际 Peer 动态发现通道、查询高度与区块分页；
- [x] 通过 Peer QSCC 获取任意历史区块和最终交易验证码；
- [x] `fabric-protos` 递归解码；
- [x] 交易 header、creator、chaincode action、endorsements；
- [x] 链码响应、事件和公共 read/write set 明文与 base64 原值双视图；
- [x] PDC hashed RW set 集合名、计数和哈希摘要；
- [x] validation code 与可读验证结果；
- [ ] 显式区块哈希链校验；
- [x] 中文 Ledger 页面、通道切换、Blocks 分页与 Transactions 展开详情。

验收：任意已存在区块可解析到交易和公共读写集；UI 对 transient/PDC 不可恢复部分有明确提示。

## Phase 4 — Chaincode Lifecycle and Execution

目标：用可审计的通用界面管理任意受控链码，不绑定当前业务合约。

- [x] 按组织查询已安装包、按动态通道查询已提交定义；
- [ ] 各组织已批准定义的独立查询；
- [x] 基于网络工作区相对路径的部署/升级表单；
- [x] chaincode language、collections 配置路径和 signature policy 参数；
- [x] 统一部署 Job、网络互斥、取消、超时、SSE 日志和异常恢复；
- [ ] package/install/approve/readiness/commit/verify 结构化步骤与安全重试；
- [x] evaluate/submit 执行台与可选背书组织；
- [x] 通用 transient 字符串 map 编码，不进入日志和响应；
- [x] 执行输出、响应状态、耗时与可获得的交易 ID 展示；
- [ ] submit 后链码事件和最终区块验证状态关联。

当前验收：可以从已注册工作区部署链码，通过实时日志观察脚本内部生命周期阶段，并从控制台执行 evaluate/submit。结构化分步骤重试和 submit 最终回执关联仍待完成。

## Phase 5 — Hardening

目标：完成生产前安全加固。

- [ ] 通用自定义链码表单 schema；
- [ ] OIDC/RBAC；
- [ ] 审计检索与导出；
- [ ] PostgreSQL/Redis 可选部署；
- [ ] worker 权限隔离和秘密管理；
- [ ] API/前端端到端测试。

## Phase 6 — Caliper (deferred)

目标：定义并运行可复现的网络压测。

- [ ] Test Plan、workload 和 network config 管理；
- [ ] 指定交易、速率、worker、round 和持续时间；
- [ ] Caliper 容器化执行；
- [ ] 实时进度与资源指标；
- [ ] HTML/JSON 报告归档和对比。

在 Phase 1–5 的作业、审计、报告存储稳定后再开始该阶段。
