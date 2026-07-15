import { RefreshCw } from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';

type NetworkDetailHeaderProps = {
  networkId: string;
  displayName: string;
  eyebrow: string;
  title: string;
  description: string;
  refreshing: boolean;
  onRefresh: () => void;
};

export function NetworkDetailHeader({
  networkId,
  displayName,
  eyebrow,
  title,
  description,
  refreshing,
  onRefresh,
}: NetworkDetailHeaderProps) {
  const encodedNetworkId = encodeURIComponent(networkId);

  return (
    <>
      <section className="network-detail-heading">
        <div>
          <div className="network-breadcrumb">
            <Link to="/networks">Networks</Link>
            <span>/</span>
            <strong>{displayName}</strong>
          </div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button
          className="icon-button network-refresh"
          type="button"
          onClick={onRefresh}
          aria-label="Refresh network data"
          title="Refresh"
          disabled={refreshing}
        >
          <RefreshCw size={17} className={refreshing ? 'icon-spin' : undefined} />
        </button>
      </section>

      <nav className="network-tabs" aria-label="Selected network views">
        <NavLink to={`/networks/${encodedNetworkId}/topology`}>Topology</NavLink>
        <NavLink to={`/networks/${encodedNetworkId}/nodes`}>Nodes</NavLink>
      </nav>
    </>
  );
}
