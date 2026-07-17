import type {
  JobStatus,
  JobAction,
  JobKind,
  NetworkManagementMode,
  NetworkLifecycleAction,
  NetworkNodeRuntimeState,
  NetworkNodeType,
  NetworkRuntimeStatus,
} from '@plus-fabric/shared';

import { ControlPlaneApiError } from '../api/control-plane';

const apiErrorMessages: Record<string, string> = {
  invalid_request: '提交的请求内容不正确，请检查各字段后重试。',
  network_exists: '该网络 ID 已经注册，请使用其他 ID。',
  invalid_network_config: '网络配置无法解析，请检查配置文件格式和必填字段。',
  network_import_disabled: '管理员尚未配置允许导入的网络工作区。',
  workspace_not_found: '指定的网络工作区不存在或不是目录。',
  workspace_not_allowed: '指定的网络工作区不在管理员允许的目录范围内。',
  invalid_config_path: '配置文件必须使用网络工作区内的相对路径。',
  config_not_found: '在指定网络工作区内找不到配置文件。',
  invalid_network_id: '网络 ID 格式不正确。',
  network_not_found: '找不到指定网络，请返回网络列表重新选择。',
  network_config_unavailable: '当前无法读取该网络的配置文件。',
  invalid_node_id: '节点 ID 格式不正确。',
  node_not_found: '该节点不在当前网络的配置中。',
  not_found: '请求的控制平面资源不存在。',
  internal_error: '控制平面暂时无法完成请求，请稍后重试。',
  network_scope_mismatch: '控制平面返回了其他网络的数据，已拒绝显示。',
  invalid_job_id: '作业 ID 格式不正确。',
  job_not_found: '找不到指定作业。',
  job_not_active: '该作业已经结束或不在当前进程中运行。',
  network_job_active: '该网络已有运维作业正在执行，请等待完成后重试。',
  network_confirmation_required: '清理网络前必须输入当前网络 ID 进行确认。',
  network_script_unavailable: '该网络工作区没有可执行的 network.sh。',
  invalid_network_action: '不支持该网络操作。',
  invalid_channel_name: '通道名称格式不正确。',
  channel_not_found: '当前网络的 Peer 未加入该通道。',
  invalid_block_query: '区块分页参数不正确。',
  invalid_block_number: '区块编号格式不正确。',
  ledger_context_unavailable: '缺少查询账本所需的 Fabric CLI、管理员身份或 TLS 文件。',
  ledger_unavailable: '暂时无法从 Fabric Peer 读取账本，请确认网络和节点正在运行。',
  channel_scope_mismatch: '控制平面返回了其他通道的数据，已拒绝显示。',
  block_scope_mismatch: '控制平面返回了其他区块的数据，已拒绝显示。',
  invalid_chaincode_deployment: '链码部署参数不正确，请检查通道、版本、序列和路径。',
  invalid_contract_request: '合约执行参数不正确，请检查函数和参数格式。',
  chaincode_context_unavailable: '缺少链码操作所需的 Fabric CLI、管理员身份或 TLS 文件。',
  chaincode_unavailable: '暂时无法查询或执行链码，请确认网络和 Peer 正在运行。',
  chaincode_organization_not_found: '找不到用于执行合约的组织。',
  chaincode_target_organization_not_found: '找不到指定的背书目标组织。',
  chaincode_target_not_joined: '指定背书组织尚未加入目标通道。',
  chaincode_targets_unavailable: '目标通道没有可用于背书的已配置 Peer。',
  chaincode_deployment_script_unavailable: '网络工作区没有可执行的 upgrade_chaincode.sh。',
  chaincode_source_not_found: '链码源码目录不存在或不在当前网络工作区内。',
  collections_config_not_found: 'Collections 配置文件不存在或不在当前网络工作区内。',
};

const runtimeStateLabels: Record<NetworkNodeRuntimeState, string> = {
  'docker-unavailable': 'Docker 不可用',
  missing: '容器缺失',
  created: '已创建',
  running: '运行中',
  paused: '已暂停',
  restarting: '重启中',
  degraded: '服务降级',
  exited: '已退出',
  dead: '已失效',
  unknown: '未知',
};

const networkStatusLabels: Record<NetworkRuntimeStatus, string> = {
  unknown: '未知',
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  degraded: '已降级',
  stopping: '停止中',
  error: '异常',
};

const managementModeLabels: Record<NetworkManagementMode, string> = {
  imported: '已导入',
  managed: '平台管理',
};

const nodeTypeLabels: Record<NetworkNodeType, string> = {
  peer: 'Peer 节点',
  orderer: 'Orderer 节点',
  ca: 'CA 节点',
};

const jobStatusLabels: Record<JobStatus, string> = {
  queued: '等待执行',
  running: '执行中',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
};

const networkActionLabels: Record<NetworkLifecycleAction, string> = {
  up: '部署网络',
  stop: '停止网络',
  restart: '恢复网络',
  down: '清理网络',
};

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ControlPlaneApiError)) return fallback;
  return (error.code && apiErrorMessages[error.code]) || fallback;
}

export function getRuntimeStateLabel(state: NetworkNodeRuntimeState): string {
  return runtimeStateLabels[state];
}

export function getNetworkStatusLabel(status: NetworkRuntimeStatus): string {
  return networkStatusLabels[status];
}

export function getManagementModeLabel(mode: NetworkManagementMode): string {
  return managementModeLabels[mode];
}

export function getNodeTypeLabel(type: NetworkNodeType): string {
  return nodeTypeLabels[type];
}

export function getJobStatusLabel(status: JobStatus): string {
  return jobStatusLabels[status];
}

export function getNetworkActionLabel(action: NetworkLifecycleAction): string {
  return networkActionLabels[action];
}

export function getJobActionLabel(kind: JobKind, action: JobAction): string {
  if (kind === 'chaincode-deployment') return '部署链码';
  return action in networkActionLabels
    ? networkActionLabels[action as NetworkLifecycleAction]
    : action;
}

export function getOrganizationTypeLabel(type: 'peer' | 'orderer'): string {
  return type === 'peer' ? '对等节点组织' : '排序节点组织';
}

export function getOrganizationName(name: string): string {
  return name === 'Orderer organization' ? '排序节点组织' : name;
}

export function getContainerStatusLabel(status: string | null): string | null {
  if (!status) return null;
  return (
    {
      created: '已创建',
      running: '运行中',
      paused: '已暂停',
      restarting: '重启中',
      removing: '删除中',
      exited: '已退出',
      dead: '已失效',
    }[status] ?? status
  );
}

export function getHealthLabel(health: string | null): string | null {
  if (!health) return null;
  return (
    {
      healthy: '健康',
      unhealthy: '不健康',
      starting: '检查中',
    }[health] ?? health
  );
}

export function getEndpointKindLabel(kind: string): string {
  return (
    {
      grpc: '业务端点',
      admin: '管理端点',
      operations: '运维端点',
      metrics: '指标端点',
      ca: 'CA 端点',
    }[kind] ?? kind
  );
}

export function getRuntimeReason(reason: string | null): string | null {
  if (!reason) return null;
  if (reason.includes('Docker CLI is not installed')) return '控制平面主机尚未安装 Docker CLI。';
  if (reason.includes('Docker daemon is unavailable')) return '控制平面进程无法访问 Docker 服务。';
  if (reason.includes('Docker became unavailable')) return '读取容器期间 Docker 服务失去连接。';
  if (reason.includes('container does not exist')) return '节点已配置，但对应的 Docker 容器不存在。';
  if (reason.includes('not attached to the network')) return '容器未接入该 Fabric 网络配置的 Docker 网络。';
  if (reason.includes('container health as')) return 'Docker 报告该容器的健康状态异常。';
  if (reason.includes('service port is unreachable')) {
    return '容器正在运行，但节点主服务端口不可达。';
  }
  return '节点运行状态异常，请检查 Docker 容器详情。';
}

export function formatDateTimeZh(value: string | null): string {
  if (!value) return '暂无数据';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}
