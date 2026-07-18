import { useMemo } from 'react';

import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Building2,
  Cable,
  CircleDot,
  Database,
  Network,
  RadioTower,
  ShieldCheck,
} from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';

import { getNetworkNodes, getNetworkTopology } from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import {
  getApiErrorMessage,
  getOrganizationName,
  getOrganizationTypeLabel,
  getRuntimeStateLabel,
} from '../../i18n/zh-CN';
import { NetworkDetailHeader } from './NetworkDetailHeader';

const nodeIcons = {
  peer: RadioTower,
  orderer: Box,
  ca: ShieldCheck,
  couchdb: Database,
};

export function NetworkTopologyPage() {
  const { networkId } = useParams();
  const topologyQuery = useQuery({
    queryKey: ['network-topology', networkId],
    queryFn: () => getNetworkTopology(networkId!),
    enabled: Boolean(networkId),
    staleTime: 30_000,
  });
  const nodesQuery = useQuery({
    queryKey: ['network-nodes', networkId],
    queryFn: () => getNetworkNodes(networkId!),
    enabled: Boolean(networkId),
    refetchInterval: 10_000,
  });
  const runtimeByNode = useMemo(
    () => new Map(nodesQuery.data?.items.map((node) => [node.id, node.runtime]) ?? []),
    [nodesQuery.data],
  );

  if (!networkId) return <Navigate to="/networks" replace />;

  const refresh = () => {
    void Promise.all([topologyQuery.refetch(), nodesQuery.refetch()]);
  };
  const topology = topologyQuery.data;
  const topologyError = topologyQuery.error;

  return (
    <div className="page-stack page-enter">
      <NetworkDetailHeader
        networkId={networkId}
        displayName={topology?.networkName ?? networkId}
        eyebrow="网络拓扑"
        title={topology?.networkName ?? '正在解析网络拓扑'}
        description={
          topology
            ? `${topology.domain} · Docker 网络 ${topology.dockerNetwork}`
            : '正在加载已配置的组织、节点和通道。'
        }
        refreshing={topologyQuery.isFetching || nodesQuery.isFetching}
        onRefresh={refresh}
      />

      {topologyQuery.isPending ? (
        <div className="query-state topology-state" role="status">
          <span className="query-state__spinner" aria-hidden="true" />
          <div>
            <h3>正在加载已配置拓扑</h3>
            <p>正在解析当前网络定义。</p>
          </div>
        </div>
      ) : topologyError || !topology ? (
        <div className="query-state query-state--error topology-state" role="alert">
          <div>
            <h3>网络拓扑不可用</h3>
            <p>{getApiErrorMessage(topologyError, '控制平面无法加载该网络。')}</p>
          </div>
          <button className="secondary-action" type="button" onClick={refresh}>
            重试
          </button>
        </div>
      ) : (
        <>
          <section className="topology-metrics" aria-label="拓扑摘要">
            <TopologyMetric label="组织" value={topology.organizations.length} icon={Building2} />
            <TopologyMetric label="已配置节点" value={topology.nodes.length} icon={CircleDot} />
            <TopologyMetric label="通道" value={topology.channels.length} icon={Cable} />
            <TopologyMetric
              label="运行中容器"
              value={nodesQuery.data ? `${nodesQuery.data.running}/${nodesQuery.data.total}` : '—'}
              icon={Network}
            />
          </section>

          {nodesQuery.isError ? (
            <div className="runtime-notice runtime-notice--warning" role="status">
              实时节点状态不可用，已配置拓扑仍可正常查看。
            </div>
          ) : !nodesQuery.isPending && nodesQuery.data && !nodesQuery.data.dockerAvailable ? (
            <div className="runtime-notice runtime-notice--warning" role="status">
              控制平面无法访问 Docker，已配置拓扑仍可正常查看。
            </div>
          ) : null}

          <Panel eyebrow="配置拓扑图" title="组织与节点" className="topology-panel">
            <div className="topology-root">
              <div className="topology-root__signal" aria-hidden="true">
                <Network size={20} />
              </div>
              <div>
                <strong>{topology.networkName}</strong>
                <span>{topology.dockerNetwork}</span>
              </div>
              <span className="topology-root__tls">
                TLS {topology.tlsEnabled ? '已启用' : '已停用'}
              </span>
            </div>

            <div className="organization-stack">
              {topology.organizations.map((organization) => {
                const organizationNodes = organization.nodeIds
                  .map((nodeId) => topology.nodes.find((node) => node.id === nodeId))
                  .filter((node) => node !== undefined);

                return (
                  <section className="organization-lane" key={organization.id}>
                    <header>
                      <div className="organization-lane__mark" aria-hidden="true">
                        <Building2 size={17} />
                      </div>
                      <div>
                        <strong>{getOrganizationName(organization.name)}</strong>
                        <span>
                          {organization.mspId} · {organization.domain}
                        </span>
                      </div>
                      <span>{getOrganizationTypeLabel(organization.type)}</span>
                    </header>
                    <div className="organization-lane__nodes">
                      {organizationNodes.map((node) => {
                        const Icon = nodeIcons[node.type];
                        const runtime = runtimeByNode.get(node.id);
                        const runtimeState = runtime?.state ?? 'unknown';
                        return (
                          <Link
                            className="topology-node"
                            key={node.id}
                            to={`/networks/${encodeURIComponent(networkId)}/nodes#${encodeURIComponent(node.id)}`}
                          >
                            <span
                              className={`topology-node__signal topology-node__signal--${runtimeState}`}
                              aria-hidden="true"
                            />
                            <Icon size={17} />
                            <span>
                              <strong>{node.name}</strong>
                              <small>{node.containerName}</small>
                            </span>
                            <em>{getRuntimeStateLabel(runtimeState)}</em>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </Panel>

          <Panel eyebrow="账本成员关系" title="已配置通道">
            {topology.channels.length === 0 ? (
              <div className="channel-empty">该网络配置中未声明通道。</div>
            ) : (
              <div className="channel-list">
                {topology.channels.map((channel) => (
                  <article className="channel-row" key={channel.name}>
                    <Cable size={17} />
                    <div>
                      <strong>{channel.name}</strong>
                      <span>{channel.profile ?? '未声明通道配置模板'}</span>
                    </div>
                    <div className="channel-row__members">
                      {channel.memberOrganizations.map((organization) => (
                        <span key={organization}>{organization}</span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function TopologyMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: typeof Building2;
}) {
  return (
    <div className="topology-metric">
      <Icon size={16} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
