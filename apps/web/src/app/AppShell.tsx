import {
  Activity,
  Blocks,
  Boxes,
  ChevronDown,
  CircuitBoard,
  Gauge,
  FileCog,
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
  { label: '账本', icon: Blocks },
  { label: '链码', icon: TerminalSquare },
  { label: '运维', icon: Activity },
  { label: '测试', icon: Gauge },
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
    checking: '正在检查控制平面',
    offline: '控制平面离线',
    degraded: '控制平面已降级',
    ok: '控制平面在线',
  }[healthState];
  const networkSelectorLabel = selectedNetwork
    ? selectedNetwork.displayName
    : networksQuery.isError
    ? '网络注册表不可用'
    : (networksQuery.data?.total ?? 0) > 0
      ? '选择网络'
      : '未选择网络';

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <CircuitBoard size={22} strokeWidth={1.7} />
          </div>
          <div>
            <span className="brand-name">Fabric</span>
            <span className="brand-subtitle">控制平面</span>
          </div>
        </div>

        <div className="network-context">
          <span className="eyebrow">网络上下文</span>
          <NavLink
            className="network-selector"
            to="/networks"
            aria-label="打开网络注册表"
          >
            <span className="network-selector__signal" />
            <span>{networkSelectorLabel}</span>
            <ChevronDown size={14} />
          </NavLink>
        </div>

        <nav className="navigation" aria-label="主导航">
          <span className="navigation-label">网络集群</span>
          <NavLink className="navigation-link" to="/" end aria-label="集群概览">
            <LayoutDashboard size={17} />
            <span>概览</span>
          </NavLink>
          <NavLink className="navigation-link" to="/networks" end aria-label="网络注册表">
            <Boxes size={17} />
            <span>网络</span>
          </NavLink>

          <span className="navigation-label navigation-label--spaced">当前网络</span>
          {selectedNetworkId ? (
            <>
              <NavLink
                className="navigation-link"
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/topology`}
              >
                <Network size={17} />
                <span>拓扑</span>
              </NavLink>
              <NavLink
                className="navigation-link"
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/nodes`}
              >
                <Server size={17} />
                <span>节点</span>
              </NavLink>
              <NavLink
                className="navigation-link"
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/configuration`}
              >
                <FileCog size={17} />
                <span>配置</span>
              </NavLink>
            </>
          ) : (
            <>
              <div className="navigation-link navigation-link--disabled">
                <Network size={17} />
                <span>拓扑</span>
              </div>
              <div className="navigation-link navigation-link--disabled">
                <Server size={17} />
                <span>节点</span>
              </div>
              <div className="navigation-link navigation-link--disabled">
                <FileCog size={17} />
                <span>配置</span>
              </div>
            </>
          )}
          {futureNavigation.map(({ label, icon: Icon }) => (
            <div className="navigation-link navigation-link--disabled" key={label}>
              <Icon size={17} />
              <span>{label}</span>
              <span className="navigation-soon">待开放</span>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <Settings2 size={15} />
          <span>平台设置</span>
          <span className="sidebar-footer__version">v0.1</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar-kicker">多网络运维</span>
            <span className="topbar-title">基础设施观测台</span>
          </div>
          <div className={`topbar-status topbar-status--${healthState}`}>
            <span className="topbar-status__pulse" />
            <span>{healthLabel}</span>
          </div>
        </header>
        <div className="workspace-content">
          <Outlet />
        </div>
        <nav className="mobile-nav" aria-label="移动端导航">
          <NavLink to="/" end aria-label="集群概览">
            <LayoutDashboard size={18} />
            <span>概览</span>
          </NavLink>
          <NavLink to="/networks" end aria-label="网络注册表">
            <Boxes size={18} />
            <span>网络</span>
          </NavLink>
          {selectedNetworkId ? (
            <>
              <NavLink
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/topology`}
                aria-label="当前网络拓扑"
              >
                <Network size={18} />
                <span>拓扑</span>
              </NavLink>
              <NavLink
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/nodes`}
                aria-label="当前网络节点"
              >
                <Server size={18} />
                <span>节点</span>
              </NavLink>
              <NavLink
                to={`/networks/${encodeURIComponent(selectedNetworkId)}/configuration`}
                aria-label="当前网络配置"
              >
                <FileCog size={18} />
                <span>配置</span>
              </NavLink>
            </>
          ) : null}
        </nav>
      </main>
    </div>
  );
}
