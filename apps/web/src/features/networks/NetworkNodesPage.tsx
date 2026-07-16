import { useEffect, useMemo, useState } from 'react';

import type { NetworkNode } from '@plus-fabric/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  ChevronDown,
  CircleAlert,
  RadioTower,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { Navigate, useLocation, useParams } from 'react-router-dom';

import {
  getNetworkNodes,
  getNetworkTopology,
} from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import {
  formatDateTimeZh,
  getApiErrorMessage,
  getContainerStatusLabel,
  getEndpointKindLabel,
  getHealthLabel,
  getOrganizationName,
  getRuntimeReason,
  getRuntimeStateLabel,
} from '../../i18n/zh-CN';
import { NetworkDetailHeader } from './NetworkDetailHeader';

type NodeFilter = 'all' | 'running' | 'attention';

const nodeIcons = {
  peer: RadioTower,
  orderer: Box,
  ca: ShieldCheck,
};

const nodeFilterLabels: Record<NodeFilter, string> = {
  all: '全部',
  running: '运行中',
  attention: '需关注',
};

export function NetworkNodesPage() {
  const { networkId } = useParams();
  const location = useLocation();
  const [filter, setFilter] = useState<NodeFilter>('all');
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const nodesQuery = useQuery({
    queryKey: ['network-nodes', networkId],
    queryFn: () => getNetworkNodes(networkId!),
    enabled: Boolean(networkId),
    refetchInterval: 8_000,
  });
  const topologyQuery = useQuery({
    queryKey: ['network-topology', networkId],
    queryFn: () => getNetworkTopology(networkId!),
    enabled: Boolean(networkId),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!location.hash) {
      setExpandedNodeId(null);
      return;
    }

    let nodeId: string;
    try {
      nodeId = decodeURIComponent(location.hash.slice(1));
    } catch {
      setExpandedNodeId(null);
      return;
    }

    setExpandedNodeId(nodeId);
    if (!nodesQuery.isPending) {
      requestAnimationFrame(() => {
        document.getElementById(nodeId)?.scrollIntoView({ block: 'center' });
      });
    }
  }, [location.hash, nodesQuery.isPending]);

  const filteredNodes = useMemo(() => {
    const items = nodesQuery.data?.items ?? [];
    if (filter === 'running') return items.filter((node) => node.runtime.containerRunning);
    if (filter === 'attention') {
      return items.filter(
        (node) => !node.runtime.containerRunning || node.runtime.degradedReason !== null,
      );
    }
    return items;
  }, [filter, nodesQuery.data]);

  if (!networkId) return <Navigate to="/networks" replace />;

  const nodes = nodesQuery.data;
  const topology = topologyQuery.data;
  const refresh = () => {
    void Promise.all([nodesQuery.refetch(), topologyQuery.refetch()]);
  };

  return (
    <div className="page-stack page-enter">
      <NetworkDetailHeader
        networkId={networkId}
        displayName={topology?.networkName ?? networkId}
        eyebrow="运行状态清单"
        title="已配置节点"
        description={
          topology
            ? `${topology.domain} · Docker 网络 ${topology.dockerNetwork}`
            : '查看 Peer、Orderer 和证书颁发机构的 Docker 状态。'
        }
        refreshing={nodesQuery.isFetching || topologyQuery.isFetching}
        onRefresh={refresh}
      />

      {nodesQuery.isPending ? (
        <div className="query-state topology-state" role="status">
          <span className="query-state__spinner" aria-hidden="true" />
          <div>
            <h3>正在观测已配置容器</h3>
            <p>正在读取当前网络的运行状态。</p>
          </div>
        </div>
      ) : nodesQuery.isError || !nodes ? (
        <div className="query-state query-state--error topology-state" role="alert">
          <div>
            <h3>节点清单不可用</h3>
            <p>
              {getApiErrorMessage(nodesQuery.error, '控制平面无法加载节点状态。')}
            </p>
          </div>
          <button className="secondary-action" type="button" onClick={() => nodesQuery.refetch()}>
            重试
          </button>
        </div>
      ) : (
        <>
          <section className="node-summary" aria-label="节点运行状态摘要">
            <NodeSummaryItem label="已配置" value={nodes.total} />
            <NodeSummaryItem label="运行中" value={nodes.running} tone="running" />
            <NodeSummaryItem label="已停止" value={nodes.stopped} tone="stopped" />
            <NodeSummaryItem label="容器缺失" value={nodes.missing} tone="missing" />
            <NodeSummaryItem
              label="服务可达"
              value={`${nodes.reachable}/${nodes.total}`}
              tone="running"
            />
            <div className={`docker-state docker-state--${nodes.dockerAvailable ? 'online' : 'offline'}`}>
              <Server size={16} />
              <span>Docker {nodes.dockerAvailable ? '已连接' : '不可用'}</span>
            </div>
          </section>

          {!nodes.dockerAvailable ? (
            <div className="runtime-notice runtime-notice--warning" role="status">
              <CircleAlert size={17} />
              无法连接 Docker，节点定义仍会显示，但不包含实时容器数据。
            </div>
          ) : null}

          <Panel
            eyebrow={`观测时间 ${formatDateTimeZh(nodes.observedAt)}`}
            title={`${filteredNodes.length} 个节点`}
            action={
              <div className="node-filters" aria-label="筛选节点">
                {(['all', 'running', 'attention'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={filter === value ? 'active' : undefined}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {nodeFilterLabels[value]}
                  </button>
                ))}
              </div>
            }
          >
            {filteredNodes.length === 0 ? (
              <div className="channel-empty">没有节点符合当前状态筛选条件。</div>
            ) : (
              <div className="node-inventory">
                {filteredNodes.map((node) => (
                  <NodeInventoryRow
                    node={node}
                    key={node.id}
                    expanded={expandedNodeId === node.id}
                    onToggle={() =>
                      setExpandedNodeId((current) => (current === node.id ? null : node.id))
                    }
                  />
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function NodeSummaryItem({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'running' | 'stopped' | 'missing';
}) {
  return (
    <div className={`node-summary__item node-summary__item--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NodeInventoryRow({
  node,
  expanded,
  onToggle,
}: {
  node: NetworkNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = nodeIcons[node.type];

  return (
    <article className={`node-inventory__row${expanded ? ' is-expanded' : ''}`} id={node.id}>
      <button
        type="button"
        className="node-inventory__summary"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`runtime-${node.id}`}
      >
        <span className={`node-state-dot node-state-dot--${node.runtime.state}`} aria-hidden="true" />
        <span className="node-type-icon" aria-hidden="true">
          <Icon size={17} />
        </span>
        <span className="node-inventory__identity">
          <strong>{node.name}</strong>
          <small>{node.containerName}</small>
        </span>
        <span className="node-inventory__org">
          <strong>{getOrganizationName(node.organizationName)}</strong>
          <small>{node.mspId}</small>
        </span>
        <span className="node-inventory__image">{node.runtime.image ?? '未观测到镜像'}</span>
        <span className={`node-state-label node-state-label--${node.runtime.state}`}>
          {getRuntimeStateLabel(node.runtime.state)}
        </span>
        <ChevronDown size={17} className="node-inventory__chevron" />
      </button>

      {expanded ? <NodeRuntimeDetails node={node} /> : null}
    </article>
  );
}

function NodeRuntimeDetails({ node }: { node: NetworkNode }) {
  return (
    <div className="node-runtime-detail" id={`runtime-${node.id}`}>
      {node.runtime.degradedReason ? (
        <div className="node-runtime-detail__warning">
          <CircleAlert size={15} />
          {getRuntimeReason(node.runtime.degradedReason)}
        </div>
      ) : null}
      <dl>
        <RuntimeField label="容器 ID" value={shortContainerId(node.runtime.containerId)} mono />
        <RuntimeField label="Docker 状态" value={getContainerStatusLabel(node.runtime.status)} />
        <RuntimeField label="健康状态" value={getHealthLabel(node.runtime.health)} />
        <RuntimeField
          label="服务端口"
          value={
            node.runtime.serviceReachable === null
              ? '尚未探测'
              : node.runtime.serviceReachable
                ? '可达'
                : '不可达'
          }
        />
        <RuntimeField label="IP 地址" value={node.runtime.ipAddress} mono />
        <RuntimeField
          label="目标网络"
          value={
            node.runtime.networkAttached === null
              ? null
              : node.runtime.networkAttached
                ? '已接入'
                : '未接入'
          }
        />
        <RuntimeField
          label="重启次数"
          value={node.runtime.restartCount === null ? null : String(node.runtime.restartCount)}
        />
        <RuntimeField label="启动时间" value={formatDateTimeZh(node.runtime.startedAt)} />
        <RuntimeField label="结束时间" value={formatDateTimeZh(node.runtime.finishedAt)} />
      </dl>
      <div className="node-endpoints">
        <span>已配置端点</span>
        <div>
          {node.endpoints.map((endpoint) => (
            <code key={`${endpoint.kind}-${endpoint.port}`}>
              {getEndpointKindLabel(endpoint.kind)} ·{' '}
              {`${endpoint.protocol}://${endpoint.host}:${endpoint.port}`}
            </code>
          ))}
        </div>
      </div>
    </div>
  );
}

function RuntimeField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono-value' : undefined}>{value ?? '暂无数据'}</dd>
    </div>
  );
}

function shortContainerId(value: string | null): string | null {
  return value ? value.slice(0, 12) : null;
}
