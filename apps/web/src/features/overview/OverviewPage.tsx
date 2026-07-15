import { useQuery } from '@tanstack/react-query';
import { Activity, Boxes, RadioTower, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';

import { getNetworks, getSystemHealth } from '../../api/control-plane';
import { MetricCard } from '../../components/MetricCard';
import { Panel } from '../../components/Panel';

export function OverviewPage() {
  const healthQuery = useQuery({
    queryKey: ['system-health'],
    queryFn: getSystemHealth,
    refetchInterval: 10_000,
  });
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    refetchInterval: 10_000,
  });

  const healthMetric = healthQuery.isPending
    ? { value: 'CHECKING', detail: 'Waiting for API heartbeat', tone: 'neutral' as const }
    : healthQuery.isError
      ? { value: 'UNREACHABLE', detail: 'The API heartbeat request failed', tone: 'amber' as const }
      : healthQuery.data.status === 'degraded'
        ? { value: 'DEGRADED', detail: 'The API reported a degraded state', tone: 'amber' as const }
        : { value: 'ONLINE', detail: 'API heartbeat is healthy', tone: 'cyan' as const };
  const networkCount = networksQuery.data?.total;
  const networkMetric = networksQuery.isPending
    ? { value: '…', detail: 'Loading network registry', tone: 'neutral' as const }
    : networksQuery.isError
      ? { value: 'ERR', detail: 'Network registry is unavailable', tone: 'amber' as const }
      : {
          value: String(networkCount ?? 0),
          detail: 'No default network is injected',
          tone: 'cyan' as const,
        };

  return (
    <div className="page-stack page-enter">
      <section className="hero">
        <div className="hero__copy">
          <span className="eyebrow">Fleet command</span>
          <h1>
            One control surface.
            <span>Every Fabric network.</span>
          </h1>
          <p>
            Register independent networks, observe their topology, inspect ledger activity,
            and execute controlled operations without exposing administrative identities to
            the browser.
          </p>
        </div>
        <div className="hero__telemetry" aria-hidden="true">
          <div className="radar-orbit radar-orbit--outer" />
          <div className="radar-orbit radar-orbit--inner" />
          <div className="radar-core">
            <RadioTower size={28} strokeWidth={1.4} />
          </div>
          <span className="radar-label radar-label--top">registry</span>
          <span className="radar-label radar-label--right">drivers</span>
          <span className="radar-label radar-label--bottom">events</span>
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard
          label="Registered networks"
          value={networkMetric.value}
          detail={networkMetric.detail}
          icon={Boxes}
          tone={networkMetric.tone}
        />
        <MetricCard
          label="Control plane"
          value={healthMetric.value}
          detail={healthMetric.detail}
          icon={ShieldCheck}
          tone={healthMetric.tone}
        />
        <MetricCard
          label="Active operations"
          value="0"
          detail="Job engine is not enabled yet"
          icon={Activity}
        />
      </section>

      <div className="dashboard-grid">
        <Panel
          eyebrow="Registry"
          title="Network fleet"
          className="panel--fleet"
          action={
            <Link className="text-link" to="/networks">
              Open registry <span aria-hidden="true">↗</span>
            </Link>
          }
        >
          {networksQuery.isPending ? (
            <div className="query-state">
              <span className="query-state__spinner" />
              <div>
                <h3>Loading network registry</h3>
                <p>The control plane is resolving registered network definitions.</p>
              </div>
            </div>
          ) : networksQuery.isError ? (
            <div className="query-state query-state--error">
              <div>
                <h3>Network registry unavailable</h3>
                <p>The API did not return a valid registry response.</p>
              </div>
              <button className="secondary-action" type="button" onClick={() => networksQuery.refetch()}>
                Retry
              </button>
            </div>
          ) : networkCount === 0 ? (
            <div className="empty-registry">
              <div className="empty-registry__glyph" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div>
                <h3>The registry is intentionally empty.</h3>
                <p>
                  Create a managed Fabric network or import an existing one. Networks remain
                  isolated by workspace, Docker project, credentials, and operation locks.
                </p>
              </div>
              <Link className="primary-action" to="/networks">
                Register a network
              </Link>
            </div>
          ) : (
            <div className="query-state query-state--ready">
              <div>
                <h3>{networkCount} networks are registered.</h3>
                <p>Open the registry to inspect and select an isolated network context.</p>
              </div>
              <Link className="primary-action" to="/networks">
                View fleet
              </Link>
            </div>
          )}
        </Panel>

        <Panel eyebrow="Architecture" title="Control path" className="panel--control-path">
          <div className="control-path">
            <div className="control-node control-node--active">
              <span>01</span>
              <strong>Registry</strong>
              <small>network definitions</small>
            </div>
            <div className="control-link" />
            <div className="control-node">
              <span>02</span>
              <strong>Driver</strong>
              <small>isolated adapter</small>
            </div>
            <div className="control-link" />
            <div className="control-node">
              <span>03</span>
              <strong>Fabric</strong>
              <small>network runtime</small>
            </div>
          </div>
        </Panel>
      </div>

      <Panel eyebrow="Activity" title="Operational timeline">
        <div className="timeline-empty">
          <span className="timeline-empty__line" />
          <span className="timeline-empty__dot" />
          <div>
            <strong>No operations recorded</strong>
            <p>Deployments, lifecycle changes, and contract submissions will appear here.</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
