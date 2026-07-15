import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './AppShell';
import { NetworksPage } from '../features/networks/NetworksPage';
import { NetworkNodesPage } from '../features/networks/NetworkNodesPage';
import { NetworkTopologyPage } from '../features/networks/NetworkTopologyPage';
import { OverviewPage } from '../features/overview/OverviewPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="networks" element={<NetworksPage />} />
        <Route path="networks/:networkId/topology" element={<NetworkTopologyPage />} />
        <Route path="networks/:networkId/nodes" element={<NetworkNodesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
