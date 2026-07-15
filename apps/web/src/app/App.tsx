import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './AppShell';
import { NetworksPage } from '../features/networks/NetworksPage';
import { OverviewPage } from '../features/overview/OverviewPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="networks" element={<NetworksPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
