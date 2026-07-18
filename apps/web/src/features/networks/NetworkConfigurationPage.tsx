import { useQuery } from '@tanstack/react-query';
import {
  Cable,
  Database,
  FileCog,
  LockKeyhole,
  RadioTower,
  Server,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Navigate, useParams } from 'react-router-dom';

import { getNetworkConfiguration } from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import { getApiErrorMessage } from '../../i18n/zh-CN';
import { NetworkDetailHeader } from './NetworkDetailHeader';

export function NetworkConfigurationPage() {
  const { networkId } = useParams();
  const configurationQuery = useQuery({
    queryKey: ['network-configuration', networkId],
    queryFn: () => getNetworkConfiguration(networkId!),
    enabled: Boolean(networkId),
    staleTime: 30_000,
  });

  if (!networkId) return <Navigate to="/networks" replace />;

  const configuration = configurationQuery.data;

  return (
    <div className="page-stack page-enter">
      <NetworkDetailHeader
        networkId={networkId}
        displayName={configuration?.networkName ?? networkId}
        eyebrow="脱敏配置"
        title={configuration?.networkName ?? '正在读取网络配置'}
        description={
          configuration
            ? `${configuration.domain} · Docker 网络 ${configuration.dockerNetwork}`
            : '正在读取服务端允许公开的网络配置。'
        }
        refreshing={configurationQuery.isFetching}
        onRefresh={() => void configurationQuery.refetch()}
      />

      {configurationQuery.isPending ? (
        <div className="query-state topology-state" role="status">
          <span className="query-state__spinner" aria-hidden="true" />
          <div>
            <h3>正在加载脱敏配置</h3>
            <p>密码、私钥和管理员身份不会发送到浏览器。</p>
          </div>
        </div>
      ) : configurationQuery.isError || !configuration ? (
        <div className="query-state query-state--error topology-state" role="alert">
          <div>
            <h3>网络配置不可用</h3>
            <p>{getApiErrorMessage(configurationQuery.error, '控制平面无法加载网络配置。')}</p>
          </div>
          <button
            className="secondary-action"
            type="button"
            onClick={() => configurationQuery.refetch()}
          >
            重试
          </button>
        </div>
      ) : (
        <>
          <div className="configuration-safety" role="status">
            <LockKeyhole size={17} />
            当前页面只显示服务端脱敏后的结构化配置，不包含密码、私钥和证书内容。
          </div>

          <section className="configuration-summary" aria-label="网络配置摘要">
            <ConfigurationMetric label="Peer 组织" value={configuration.peerOrganizations.length} icon={Users} />
            <ConfigurationMetric label="Orderer" value={configuration.orderers.length} icon={Server} />
            <ConfigurationMetric label="通道" value={configuration.channels.length} icon={Cable} />
            <ConfigurationMetric
              label="TLS"
              value={configuration.tlsEnabled ? '已启用' : '已停用'}
              icon={ShieldCheck}
            />
          </section>

          <Panel eyebrow="网络标识" title="基础配置">
            <dl className="configuration-identity">
              <ConfigurationField label="网络 ID" value={configuration.networkId} mono />
              <ConfigurationField label="网络名称" value={configuration.networkName} />
              <ConfigurationField label="网络域名" value={configuration.domain} mono />
              <ConfigurationField label="Docker 网络" value={configuration.dockerNetwork} mono />
              <ConfigurationField
                label="传输安全"
                value={configuration.tlsEnabled ? 'TLS 已启用' : 'TLS 已停用'}
              />
              <ConfigurationField
                label="状态数据库"
                value={configuration.stateDatabase === 'couchdb' ? 'CouchDB' : 'LevelDB'}
              />
            </dl>
          </Panel>

          <Panel eyebrow="排序服务" title={`${configuration.orderers.length} 个 Orderer`}>
            <div className="configuration-node-list">
              {configuration.orderers.map((orderer) => (
                <article className="configuration-node-row" key={`${orderer.host}-${orderer.port}`}>
                  <span className="configuration-node-row__icon" aria-hidden="true">
                    <Database size={17} />
                  </span>
                  <div>
                    <strong>{orderer.name}</strong>
                    <small>{orderer.host}</small>
                  </div>
                  <code>{orderer.host}:{orderer.port}</code>
                </article>
              ))}
            </div>
          </Panel>

          <Panel eyebrow="共识与批次" title="Orderer 出块参数">
            <dl className="configuration-identity">
              <ConfigurationField
                label="共识类型"
                value={
                  configuration.ordererConfiguration.consensusType === 'solo'
                    ? 'Solo（实验）'
                    : 'Raft / etcdraft'
                }
              />
              <ConfigurationField
                label="批次超时"
                value={`${configuration.ordererConfiguration.batchTimeoutSeconds} 秒`}
              />
              <ConfigurationField
                label="最大交易数"
                value={String(configuration.ordererConfiguration.maxMessageCount)}
              />
              <ConfigurationField
                label="绝对大小上限"
                value={`${configuration.ordererConfiguration.absoluteMaxBytesMiB} MiB`}
              />
              <ConfigurationField
                label="首选大小上限"
                value={`${configuration.ordererConfiguration.preferredMaxBytesKiB} KiB`}
              />
            </dl>
          </Panel>

          <Panel eyebrow="对等组织" title={`${configuration.peerOrganizations.length} 个 Peer 组织`}>
            <div className="configuration-org-list">
              {configuration.peerOrganizations.map((organization) => (
                <section className="configuration-org-row" key={organization.name}>
                  <header>
                    <span className="configuration-node-row__icon" aria-hidden="true">
                      <RadioTower size={17} />
                    </span>
                    <div>
                      <strong>{organization.name}</strong>
                      <small>{organization.mspId} · {organization.domain}</small>
                    </div>
                    <span>{organization.peerCount} 个 Peer</span>
                  </header>
                  <div className="configuration-anchor-list">
                    {organization.anchorPeers.length === 0 ? (
                      <span>未配置锚节点</span>
                    ) : (
                      organization.anchorPeers.map((peer) => (
                        <code key={`${peer.host}-${peer.port}`}>
                          {peer.name} · {peer.host}:{peer.port}
                        </code>
                      ))
                    )}
                  </div>
                </section>
              ))}
            </div>
          </Panel>

          <Panel eyebrow="账本配置" title="通道">
            {configuration.channels.length === 0 ? (
              <div className="channel-empty">该网络配置中未声明通道。</div>
            ) : (
              <div className="configuration-channel-list">
                {configuration.channels.map((channel) => (
                  <article className="configuration-channel-row" key={channel.name}>
                    <Cable size={17} />
                    <div>
                      <strong>{channel.name}</strong>
                      <small>{channel.profile ?? '未声明通道配置模板'}</small>
                    </div>
                    <div>
                      {channel.memberOrganizations.map((organization) => (
                        <span key={organization}>{organization}</span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function ConfigurationMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: typeof FileCog;
}) {
  return (
    <div className="configuration-metric">
      <Icon size={17} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ConfigurationField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono-value' : undefined}>{value}</dd>
    </div>
  );
}
