import {
  Activity,
  Blocks,
  Boxes,
  ChevronDown,
  CircuitBoard,
  Gauge,
  LayoutDashboard,
  Network,
  Server,
  Settings2,
  TerminalSquare,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { matchPath, NavLink, Outlet, useLocation } from 'react-router-dom';

import { getNetworks, getSystemHealth } from '../api/control-plane';

const futureNavigation = [
  { label: 'Ledger', icon: Blocks },
  { label: 'Chaincodes', icon: TerminalSquare },
  { label: 'Operations', icon: Activity },
  { label: 'Testing', icon: Gauge },
];

export function AppShell() {
  const location = useLocation();
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
  const networkMatch = matchPath('/networks/:networkId/*', location.pathname);
  const selectedNetworkId = networkMatch?.params.networkId;
  const selectedNetwork = networksQuery.data?.items.find(
    (network) => network.id === selectedNetworkId,
  );

  const healthState = healthQuery.isPending
    ? 'checking'
    : healthQuery.isError
      ? 'offline'
      : healthQuery.data.status;
  const healthLabel = {
    checking: 'Checking control plane',
    offline: 'Control plane offline',
    degraded: 'Control plane degraded',
    ok: 'Control plane online',
  }[healthState];
  const networkSelectorLabel = selectedNetwork
    ? selectedNetwork.displayName
    : networksQuery.isError
    ? 'Registry unavailable'
    : (networksQuery.data?.total ?? 0) > 0
      ? 'Choose a network'
      : 'No network selected';

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <CircuitBoard size={22} strokeWidth={1.7} />
          </div>
          <div>
            <span className="brand-name">Fabric</span>
            <span className="brand-subtitle">Control Plane</span>
          </div>
        </div>

        <div className="network-context">
          <span className="eyebrow">Network context</span>
          <NavLink
            className="network-selector"
            to="/networks"
            aria-label="Open the network registry"
          >
            <span className="network-selector__signal" />
            <span>{networkSelectorLabel}</span>
            <ChevronDown size={14} />
          </NavLink>
        </div>

        <nav className="navigation" aria-label="Primary navigation">
          <span className="navigation-label">Fleet</span>
          <NavLink className="navigation-link" to="/" end aria-label="Fleet overview">
            <LayoutDashboard size={17} />
            <span>Overview</span>
          </NavLink>
          <NavLink className="navigation-link" to="/networks" aria-label="Network registry">
            <Boxes size={17} />
            <span>Networks</span>
          </NavLink>

          <span className="navigation-label navigation-label--spaced">Selected network</span>
          {selectedNetworkId ? (
            <>
              <NavLink
                className="navigation-link"
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/topology`}
              >
                <Network size={17} />
                <span>Topology</span>
              </NavLink>
              <NavLink
                className="navigation-link"
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/nodes`}
              >
                <Server size={17} />
                <span>Nodes</span>
              </NavLink>
            </>
          ) : (
            <>
              <div className="navigation-link navigation-link--disabled">
                <Network size={17} />
                <span>Topology</span>
              </div>
              <div className="navigation-link navigation-link--disabled">
                <Server size={17} />
                <span>Nodes</span>
              </div>
            </>
          )}
          {futureNavigation.map(({ label, icon: Icon }) => (
            <div className="navigation-link navigation-link--disabled" key={label}>
              <Icon size={17} />
              <span>{label}</span>
              <span className="navigation-soon">soon</span>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <Settings2 size={15} />
          <span>Platform settings</span>
          <span className="sidebar-footer__version">v0.1</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar-kicker">Multi-network operations</span>
            <span className="topbar-title">Infrastructure observatory</span>
          </div>
          <div className={`topbar-status topbar-status--${healthState}`}>
            <span className="topbar-status__pulse" />
            <span>{healthLabel}</span>
          </div>
        </header>
        <div className="workspace-content">
          <Outlet />
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <NavLink to="/" end aria-label="Fleet overview">
            <LayoutDashboard size={18} />
            <span>Overview</span>
          </NavLink>
          <NavLink to="/networks" aria-label="Network registry">
            <Boxes size={18} />
            <span>Networks</span>
          </NavLink>
          {selectedNetworkId ? (
            <>
              <NavLink
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/topology`}
                aria-label="Selected network topology"
              >
                <Network size={18} />
                <span>Topology</span>
              </NavLink>
              <NavLink
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/nodes`}
                aria-label="Selected network nodes"
              >
                <Server size={18} />
                <span>Nodes</span>
              </NavLink>
            </>
          ) : null}
        </nav>
      </main>
    </div>
  );
}
