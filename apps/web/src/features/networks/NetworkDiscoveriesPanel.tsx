import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  FolderClock,
  Import,
  Radar,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { NetworkDiscoveryCandidate } from '@plus-fabric/shared';

import { getNetworkDiscoveries } from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import { getApiErrorMessage } from '../../i18n/zh-CN';

type NetworkDiscoveriesPanelProps = {
  onImport(candidate: NetworkDiscoveryCandidate): void;
};

export function NetworkDiscoveriesPanel({ onImport }: NetworkDiscoveriesPanelProps) {
  const query = useQuery({
    queryKey: ['network-discoveries'],
    queryFn: getNetworkDiscoveries,
    refetchInterval: 10_000,
  });
  const discoveries = query.data?.items ?? [];
  const unregisteredCount = discoveries.filter(
    (candidate) => candidate.registrationStatus === 'unregistered',
  ).length;

  return (
    <Panel
      eyebrow="本地信号台"
      title={
        query.isPending
          ? '正在扫描脚本发现痕迹'
          : query.isError
            ? '本地网络扫描不可用'
            : unregisteredCount > 0
              ? `发现 ${unregisteredCount} 个待导入网络`
              : '没有待导入的本地网络'
      }
      action={
        <button
          className="secondary-action discovery-refresh"
          type="button"
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        >
          <RefreshCw size={15} className={query.isFetching ? 'is-spinning' : undefined} />
          {query.isFetching ? '扫描中' : '重新扫描'}
        </button>
      }
    >
      <div className="discovery-console">
        <div className="discovery-console__rail" aria-hidden="true">
          <Radar size={22} />
          <span />
          <TerminalSquare size={20} />
        </div>

        {query.isPending ? (
          <div className="discovery-empty" role="status">
            <span className="query-state__spinner" aria-hidden="true" />
            <div>
              <strong>正在读取本机发现索引</strong>
              <p>扫描由 network.sh 写入的标准清单，不会启动或注册任何网络。</p>
            </div>
          </div>
        ) : query.isError ? (
          <div className="discovery-empty discovery-empty--error">
            <AlertTriangle size={22} />
            <div>
              <strong>无法读取本地网络痕迹</strong>
              <p>{getApiErrorMessage(query.error, '发现服务暂时不可用。')}</p>
            </div>
          </div>
        ) : discoveries.length === 0 ? (
          <div className="discovery-empty">
            <FileSearch size={22} />
            <div>
              <strong>等待终端网络信号</strong>
              <p>通过新版 network.sh 启动网络后，其工作区会自动出现在这里。</p>
            </div>
          </div>
        ) : (
          <div className="discovery-list" role="list">
            {discoveries.map((candidate) => {
              const importable = candidate.registrationStatus === 'unregistered';
              return (
                <article
                  className={`discovery-row discovery-row--${candidate.registrationStatus}`}
                  key={`${candidate.manifest.networkId}:${candidate.manifest.workspaceRoot}`}
                  role="listitem"
                >
                  <div className="discovery-row__signal" aria-hidden="true">
                    <span />
                  </div>
                  <div className="discovery-row__identity">
                    <strong>{candidate.manifest.displayName}</strong>
                    <code>{candidate.manifest.networkId}</code>
                    <span>{getManifestStatusLabel(candidate.manifest.status)}</span>
                  </div>
                  <div className="discovery-row__workspace">
                    <span>工作区</span>
                    <code title={candidate.manifest.workspaceRoot}>
                      {candidate.manifest.workspaceRoot}
                    </code>
                    <small>
                      {candidate.manifest.composeProject} · {candidate.manifest.dockerNetwork}
                    </small>
                  </div>
                  <dl className="discovery-row__topology">
                    <div>
                      <dt>组织</dt>
                      <dd>{candidate.manifest.summary.peerOrganizationCount}</dd>
                    </div>
                    <div>
                      <dt>Peer</dt>
                      <dd>{candidate.manifest.summary.peerCount}</dd>
                    </div>
                    <div>
                      <dt>Orderer</dt>
                      <dd>{candidate.manifest.summary.ordererCount}</dd>
                    </div>
                    <div>
                      <dt>通道</dt>
                      <dd>{candidate.manifest.summary.channelCount}</dd>
                    </div>
                  </dl>
                  <div className="discovery-row__state">
                    {getRegistrationIcon(candidate.registrationStatus)}
                    <span>{getRegistrationStatusLabel(candidate.registrationStatus)}</span>
                    {candidate.registeredNetworkId ? (
                      <small>{candidate.registeredNetworkId}</small>
                    ) : null}
                  </div>
                  <button
                    className="secondary-action discovery-row__action"
                    type="button"
                    disabled={!importable}
                    title={
                      importable
                        ? '使用发现清单预填导入信息'
                        : getRegistrationStatusLabel(candidate.registrationStatus)
                    }
                    onClick={() => onImport(candidate)}
                  >
                    <Import size={15} />
                    {importable ? '导入' : '不可导入'}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {query.data?.invalidManifestCount ? (
          <div className="discovery-console__warning">
            <AlertTriangle size={14} />
            已忽略 {query.data.invalidManifestCount} 份损坏或版本不兼容的发现清单。
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function getManifestStatusLabel(status: NetworkDiscoveryCandidate['manifest']['status']): string {
  return {
    configured: '已配置',
    running: '脚本记录为运行中',
    stopped: '脚本记录为已暂停',
    removed: '运行资源已清理',
    unknown: '状态未知',
  }[status];
}

function getRegistrationStatusLabel(
  status: NetworkDiscoveryCandidate['registrationStatus'],
): string {
  return {
    unregistered: '等待导入',
    registered: '已在平台注册',
    conflict: '与注册表冲突',
    stale: '工作区痕迹失效',
  }[status];
}

function getRegistrationIcon(status: NetworkDiscoveryCandidate['registrationStatus']) {
  if (status === 'registered') return <CheckCircle2 size={16} />;
  if (status === 'stale') return <FolderClock size={16} />;
  if (status === 'conflict') return <AlertTriangle size={16} />;
  return <Radar size={16} />;
}
