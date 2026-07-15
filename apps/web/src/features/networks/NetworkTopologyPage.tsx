import { useMemo } from 'react';

import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Building2,
  Cable,
  CircleDot,
  Network,
  RadioTower,
  ShieldCheck,
} from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';

import { ControlPlaneApiError, getNetworkNodes, getNetworkTopology } from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import { NetworkDetailHeader } from './NetworkDetailHeader';

const nodeIcons = {
  peer: RadioTower,
  orderer: Box,
  ca: ShieldCheck,
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
        eyebrow="Network topology"
        title={topology?.networkName ?? 'Resolving network topology'}
        description={
          topology
            ? `${topology.domain} · Docker network ${topology.dockerNetwork}`
            : 'Loading the configured organizations, nodes, and channels.'
        }
        refreshing={topologyQuery.isFetching || nodesQuery.isFetching}
        onRefresh={refresh}
      />

      {topologyQuery.isPending ? (
        <div className="query-state topology-state" role="status">
          <span className="query-state__spinner" aria-hidden="true" />
          <div>
            <h3>Loading configured topology</h3>
            <p>Resolving the selected network definition.</p>
          </div>
        </div>
      ) : topologyError || !topology ? (
        <div className="query-state query-state--error topology-state" role="alert">
          <div>
            <h3>Topology unavailable</h3>
            <p>{apiErrorMessage(topologyError)}</p>
          </div>
          <button className="secondary-action" type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <section className="topology-metrics" aria-label="Topology summary">
            <TopologyMetric label="Organizations" value={topology.organizations.length} icon={Building2} />
            <TopologyMetric label="Configured nodes" value={topology.nodes.length} icon={CircleDot} />
            <TopologyMetric label="Channels" value={topology.channels.length} icon={Cable} />
            <TopologyMetric
              label="Containers running"
              value={nodesQuery.data ? `${nodesQuery.data.running}/${nodesQuery.data.total}` : '—'}
              icon={Network}
            />
          </section>

          {nodesQuery.isError ? (
            <div className="runtime-notice runtime-notice--warning" role="status">
              Live node state is unavailable. Configured topology remains visible.
            </div>
          ) : !nodesQuery.isPending && nodesQuery.data && !nodesQuery.data.dockerAvailable ? (
            <div className="runtime-notice runtime-notice--warning" role="status">
              Docker is unavailable to the control plane. Configured topology remains visible.
            </div>
          ) : null}

          <Panel eyebrow="Configured graph" title="Organizations and nodes" className="topology-panel">
            <div className="topology-root">
              <div className="topology-root__signal" aria-hidden="true">
                <Network size={20} />
              </div>
              <div>
                <strong>{topology.networkName}</strong>
                <span>{topology.dockerNetwork}</span>
              </div>
              <span className="topology-root__tls">TLS {topology.tlsEnabled ? 'enabled' : 'disabled'}</span>
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
                        <strong>{organization.name}</strong>
                        <span>
                          {organization.mspId} · {organization.domain}
                        </span>
                      </div>
                      <span>{organization.type}</span>
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
                            <em>{runtimeState}</em>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </Panel>

          <Panel eyebrow="Ledger membership" title="Configured channels">
            {topology.channels.length === 0 ? (
              <div className="channel-empty">No channels are declared in this network configuration.</div>
            ) : (
              <div className="channel-list">
                {topology.channels.map((channel) => (
                  <article className="channel-row" key={channel.name}>
                    <Cable size={17} />
                    <div>
                      <strong>{channel.name}</strong>
                      <span>{channel.profile ?? 'No profile declared'}</span>
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

function apiErrorMessage(error: unknown): string {
  return error instanceof ControlPlaneApiError
    ? error.message
    : 'The control plane could not load this network.';
}
