import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Boxes, Plus, ShieldAlert } from 'lucide-react';

import { getNetworks } from '../../api/control-plane';
import { Panel } from '../../components/Panel';

export function NetworksPage() {
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    refetchInterval: 10_000,
  });
  const networks = networksQuery.data?.items ?? [];
  const total = networksQuery.data?.total;

  return (
    <div className="page-stack page-enter">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Network registry</span>
          <h1>Independent networks, one inventory.</h1>
          <p>
            Every network owns its workspace, runtime namespace, credentials, versions, and
            operation history.
          </p>
        </div>
        <div className="page-heading__actions">
          <button className="secondary-action" type="button" disabled>
            <ArrowDownToLine size={16} /> Import network
          </button>
          <button className="primary-action" type="button" disabled title="Available in Phase 1">
            <Plus size={16} /> Create network
          </button>
        </div>
      </section>

      <div className="registry-notice">
        <ShieldAlert size={18} />
        <span>
          Registration writes are disabled in the foundation milestone. No network is inferred
          from the repository or host environment.
        </span>
      </div>

      <Panel
        eyebrow="Inventory"
        title={
          networksQuery.isPending
            ? 'Loading registered networks'
            : networksQuery.isError
              ? 'Network registry unavailable'
              : `${total ?? 0} registered network${total === 1 ? '' : 's'}`
        }
      >
        {networksQuery.isPending ? (
          <div className="network-table-empty">
            <span className="query-state__spinner" />
            <h3>Loading network definitions</h3>
          </div>
        ) : networksQuery.isError ? (
          <div className="network-table-empty network-table-empty--error">
            <ShieldAlert size={30} strokeWidth={1.35} />
            <h3>The registry request failed</h3>
            <p>No empty-state assumptions were made. Check the API and retry.</p>
            <button className="secondary-action" type="button" onClick={() => networksQuery.refetch()}>
              Retry request
            </button>
          </div>
        ) : networks.length === 0 ? (
          <div className="network-table-empty">
            <Boxes size={30} strokeWidth={1.35} />
            <h3>No network definitions</h3>
            <p>The creation and import workflows will be implemented in Phase 1.</p>
          </div>
        ) : (
          <div className="network-list" role="list">
            {networks.map((network) => (
              <article className="network-row" key={network.id} role="listitem">
                <div className={`network-row__status network-row__status--${network.status}`} />
                <div className="network-row__identity">
                  <strong>{network.displayName}</strong>
                  <span>{network.id}</span>
                </div>
                <dl>
                  <div>
                    <dt>Mode</dt>
                    <dd>{network.managementMode}</dd>
                  </div>
                  <div>
                    <dt>Fabric</dt>
                    <dd>{network.fabricVersion ?? 'unknown'}</dd>
                  </div>
                  <div>
                    <dt>Topology</dt>
                    <dd>
                      {network.organizationCount} org / {network.nodeCount} nodes
                    </dd>
                  </div>
                  <div>
                    <dt>Channels</dt>
                    <dd>{network.channelCount}</dd>
                  </div>
                </dl>
                <span className="network-row__runtime">{network.status}</span>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
