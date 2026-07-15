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
  ControlPlaneApiError,
  getNetworkNodes,
  getNetworkTopology,
} from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import { NetworkDetailHeader } from './NetworkDetailHeader';

type NodeFilter = 'all' | 'running' | 'attention';

const nodeIcons = {
  peer: RadioTower,
  orderer: Box,
  ca: ShieldCheck,
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
        eyebrow="Runtime inventory"
        title="Configured nodes"
        description={
          topology
            ? `${topology.domain} · Docker network ${topology.dockerNetwork}`
            : 'Docker state for peers, orderers, and certificate authorities.'
        }
        refreshing={nodesQuery.isFetching || topologyQuery.isFetching}
        onRefresh={refresh}
      />

      {nodesQuery.isPending ? (
        <div className="query-state topology-state" role="status">
          <span className="query-state__spinner" aria-hidden="true" />
          <div>
            <h3>Observing configured containers</h3>
            <p>Reading the selected network runtime.</p>
          </div>
        </div>
      ) : nodesQuery.isError || !nodes ? (
        <div className="query-state query-state--error topology-state" role="alert">
          <div>
            <h3>Node inventory unavailable</h3>
            <p>
              {nodesQuery.error instanceof ControlPlaneApiError
                ? nodesQuery.error.message
                : 'The control plane could not load node state.'}
            </p>
          </div>
          <button className="secondary-action" type="button" onClick={() => nodesQuery.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <section className="node-summary" aria-label="Node runtime summary">
            <NodeSummaryItem label="Configured" value={nodes.total} />
            <NodeSummaryItem label="Running" value={nodes.running} tone="running" />
            <NodeSummaryItem label="Stopped" value={nodes.stopped} tone="stopped" />
            <NodeSummaryItem label="Missing" value={nodes.missing} tone="missing" />
            <div className={`docker-state docker-state--${nodes.dockerAvailable ? 'online' : 'offline'}`}>
              <Server size={16} />
              <span>Docker {nodes.dockerAvailable ? 'connected' : 'unavailable'}</span>
            </div>
          </section>

          {!nodes.dockerAvailable ? (
            <div className="runtime-notice runtime-notice--warning" role="status">
              <CircleAlert size={17} />
              Docker cannot be reached. Node definitions are shown without live container data.
            </div>
          ) : null}

          <Panel
            eyebrow={`Observed ${formatTimestamp(nodes.observedAt)}`}
            title={`${filteredNodes.length} node${filteredNodes.length === 1 ? '' : 's'}`}
            action={
              <div className="node-filters" aria-label="Filter nodes">
                {(['all', 'running', 'attention'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={filter === value ? 'active' : undefined}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            }
          >
            {filteredNodes.length === 0 ? (
              <div className="channel-empty">No nodes match this status filter.</div>
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
  value: number;
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
          <strong>{node.organizationName}</strong>
          <small>{node.mspId}</small>
        </span>
        <span className="node-inventory__image">{node.runtime.image ?? 'No image observed'}</span>
        <span className={`node-state-label node-state-label--${node.runtime.state}`}>
          {node.runtime.state}
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
          {node.runtime.degradedReason}
        </div>
      ) : null}
      <dl>
        <RuntimeField label="Container ID" value={shortContainerId(node.runtime.containerId)} mono />
        <RuntimeField label="Docker status" value={node.runtime.status} />
        <RuntimeField label="Health" value={node.runtime.health} />
        <RuntimeField label="IP address" value={node.runtime.ipAddress} mono />
        <RuntimeField
          label="Expected network"
          value={
            node.runtime.networkAttached === null
              ? null
              : node.runtime.networkAttached
                ? 'attached'
                : 'not attached'
          }
        />
        <RuntimeField
          label="Restarts"
          value={node.runtime.restartCount === null ? null : String(node.runtime.restartCount)}
        />
        <RuntimeField label="Started" value={formatTimestamp(node.runtime.startedAt)} />
        <RuntimeField label="Finished" value={formatTimestamp(node.runtime.finishedAt)} />
      </dl>
      <div className="node-endpoints">
        <span>Configured endpoints</span>
        <div>
          {node.endpoints.map((endpoint) => (
            <code key={`${endpoint.kind}-${endpoint.port}`}>
              {endpoint.kind} · {endpoint.protocol}://{endpoint.host}:{endpoint.port}
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
      <dd className={mono ? 'mono-value' : undefined}>{value ?? 'unavailable'}</dd>
    </div>
  );
}

function shortContainerId(value: string | null): string | null {
  return value ? value.slice(0, 12) : null;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
