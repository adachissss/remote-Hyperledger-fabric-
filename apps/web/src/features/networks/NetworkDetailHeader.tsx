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
            <Link to="/networks">网络</Link>
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
          aria-label="刷新网络数据"
          title="刷新"
          disabled={refreshing}
        >
          <RefreshCw size={17} className={refreshing ? 'icon-spin' : undefined} />
        </button>
      </section>

      <nav className="network-tabs" aria-label="当前网络视图">
        <NavLink to={`/networks/${encodedNetworkId}/topology`}>拓扑</NavLink>
        <NavLink to={`/networks/${encodedNetworkId}/nodes`}>节点</NavLink>
        <NavLink to={`/networks/${encodedNetworkId}/configuration`}>配置</NavLink>
        <NavLink to={`/networks/${encodedNetworkId}/operations`}>运维</NavLink>
        <NavLink to={`/networks/${encodedNetworkId}/ledger`}>账本</NavLink>
        <NavLink to={`/networks/${encodedNetworkId}/chaincodes`}>链码</NavLink>
      </nav>
    </>
  );
}
