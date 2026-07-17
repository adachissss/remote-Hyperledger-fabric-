import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './AppShell';
import { NetworksPage } from '../features/networks/NetworksPage';
import { NetworkNodesPage } from '../features/networks/NetworkNodesPage';
import { NetworkOperationsPage } from '../features/networks/NetworkOperationsPage';
import { NetworkLedgerPage } from '../features/networks/NetworkLedgerPage';
import { NetworkChaincodesPage } from '../features/networks/NetworkChaincodesPage';
import { NetworkConfigurationPage } from '../features/networks/NetworkConfigurationPage';
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
        <Route path="networks/:networkId/configuration" element={<NetworkConfigurationPage />} />
        <Route path="networks/:networkId/operations" element={<NetworkOperationsPage />} />
        <Route path="networks/:networkId/ledger" element={<NetworkLedgerPage />} />
        <Route path="networks/:networkId/chaincodes" element={<NetworkChaincodesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
