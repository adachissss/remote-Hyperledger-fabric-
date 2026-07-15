# Fabric Control Plane Roadmap

## Phase 0 — Foundation

目标：形成可维护的工程边界和可运行空壳。

- [x] 明确架构、API 边界和安全边界；
- [ ] 建立 pnpm workspace；
- [ ] 建立 `apps/api`、`apps/web`、`packages/shared`；
- [ ] 定义通用 Network Registry、Network Driver 和 Chaincode Catalog 接口；
- [ ] API/Web health check；
- [ ] 环境配置校验、统一 lint/typecheck/build；
- [ ] 为 runtime 数据增加忽略规则。

验收：`pnpm dev` 能同时启动 API 和 Web；`pnpm typecheck`、`pnpm build` 通过。

## Phase 1 — Read-only Network Observatory

目标：不改变 Fabric 状态即可同时观察多个异名 Fabric 网络。

- [ ] 空网络注册表，支持创建或导入多个网络且不自动注入默认实例；
- [ ] 所有 API 和路由以 `networkId` 为第一维；
- [ ] 解析每个网络脱敏后的配置；
- [ ] 封装 `export-network-info.sh`；
- [ ] Docker 容器状态、镜像、IP、端口和时间；
- [ ] Fleet Overview、Network Selector、Topology、Nodes、Configuration 页面；
- [ ] 定时刷新和错误降级展示。

验收：至少两个名称和拓扑不同的网络可以同时注册；停止和运行状态均能正确展示，不串用配置、容器或凭据，也不返回密码和私钥。

## Phase 2 — Operations and Live Logs

目标：将网络生命周期变成可观察的异步作业。

- [ ] Job/JobStep 数据模型；
- [ ] managed network 独立工作区、Compose project、Docker network 和端口冲突检查；
- [ ] 将当前单工作区脚本适配为通用 `fabric-compose` driver；
- [ ] 安全子进程执行器；
- [ ] SSE 实时日志；
- [ ] up、stop、restart；
- [ ] 带二次确认的 down；
- [ ] 网络级锁、超时、取消和审计；
- [ ] Operations 页面与步骤时间线。

验收：浏览器发起部署后可以看到完整步骤、实时日志和最终状态；重复点击不会并发破坏同一网络。

## Phase 3 — Ledger Explorer

目标：实现可核验的区块和交易解析。

- [ ] 通道高度与区块分页；
- [ ] 历史区块获取；
- [ ] `fabric-protos` 递归解码；
- [ ] 交易 header、creator、chaincode action、endorsements；
- [ ] 公共 read/write set 明文与原始值双视图；
- [ ] validation code、区块哈希链校验；
- [ ] Blocks、Transactions 页面。

验收：任意已存在区块可解析到交易和公共读写集；UI 对 transient/PDC 不可恢复部分有明确提示。

## Phase 4 — Chaincode Lifecycle and Execution

目标：用可审计的通用界面管理任意受控链码，不绑定当前业务合约。

- [ ] 已安装、已批准、已提交定义查询；
- [ ] 部署/升级向导；
- [ ] collection、endorsement policy 配置；
- [ ] evaluate/submit 执行台；
- [ ] transient 参数脱敏；
- [ ] 交易回执和事件展示。

验收：可以部署仓库内链码，实时看到生命周期步骤，并从控制台安全执行 query/invoke。

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
