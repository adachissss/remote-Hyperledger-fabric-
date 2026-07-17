import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useQuery } from '@tanstack/react-query';
import type {
  LedgerBlock,
  LedgerBlockSummary,
  LedgerDecodedValue,
  LedgerNamespaceReadWriteSet,
  LedgerTransaction,
} from '@plus-fabric/shared';
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  Braces,
  CheckCircle2,
  Clock3,
  Code2,
  Database,
  FileJson,
  Fingerprint,
  Hash,
  RadioTower,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Navigate, useParams } from 'react-router-dom';

import {
  getLedgerBlock,
  getLedgerBlocks,
  getLedgerChannels,
  getNetworks,
} from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import { formatDateTimeZh, getApiErrorMessage } from '../../i18n/zh-CN';
import { NetworkDetailHeader } from './NetworkDetailHeader';

const pageSize = 10;

export function NetworkLedgerPage() {
  const { networkId } = useParams();
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedBlockNumber, setSelectedBlockNumber] = useState<string | null>(null);

  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 30_000,
  });
  const channelsQuery = useQuery({
    queryKey: ['ledger-channels', networkId],
    queryFn: () => getLedgerChannels(networkId!),
    enabled: Boolean(networkId),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const channels = channelsQuery.data?.items;
    if (!channels) return;
    if (channels.length === 0) {
      setSelectedChannel(null);
      return;
    }
    if (!selectedChannel || !channels.some((channel) => channel.name === selectedChannel)) {
      setSelectedChannel(channels[0]!.name);
      setPageCursors([undefined]);
      setPageIndex(0);
      setSelectedBlockNumber(null);
    }
  }, [channelsQuery.data, selectedChannel]);

  const currentCursor = pageCursors[pageIndex];
  const blocksQuery = useQuery({
    queryKey: ['ledger-blocks', networkId, selectedChannel, currentCursor ?? 'latest'],
    queryFn: () =>
      getLedgerBlocks(networkId!, selectedChannel!, {
        limit: pageSize,
        ...(currentCursor === undefined ? {} : { before: currentCursor }),
      }),
    enabled: Boolean(networkId && selectedChannel),
    staleTime: 10_000,
  });

  useEffect(() => {
    const firstBlock = blocksQuery.data?.items[0]?.number ?? null;
    setSelectedBlockNumber(firstBlock);
  }, [selectedChannel, currentCursor, blocksQuery.data]);

  const blockQuery = useQuery({
    queryKey: ['ledger-block', networkId, selectedChannel, selectedBlockNumber],
    queryFn: () => getLedgerBlock(networkId!, selectedChannel!, selectedBlockNumber!),
    enabled: Boolean(networkId && selectedChannel && selectedBlockNumber),
    staleTime: 60_000,
  });

  const network = networksQuery.data?.items.find((item) => item.id === networkId);
  const channel = channelsQuery.data?.items.find((item) => item.name === selectedChannel);
  const lastBlock = blocksQuery.data?.items.at(-1);
  const hasOlderBlocks =
    blocksQuery.data?.items.length === pageSize && lastBlock !== undefined && lastBlock.number !== '0';

  if (!networkId) return <Navigate to="/networks" replace />;

  const selectChannel = (channelName: string) => {
    setSelectedChannel(channelName);
    setPageCursors([undefined]);
    setPageIndex(0);
    setSelectedBlockNumber(null);
  };

  const showOlderBlocks = () => {
    if (!lastBlock || !hasOlderBlocks) return;
    const nextIndex = pageIndex + 1;
    setPageCursors((current) => {
      const next = current.slice(0, nextIndex);
      next[nextIndex] = lastBlock.number;
      return next;
    });
    setPageIndex(nextIndex);
  };

  const refresh = () => {
    void Promise.all([
      channelsQuery.refetch(),
      selectedChannel ? blocksQuery.refetch() : Promise.resolve(),
      selectedBlockNumber ? blockQuery.refetch() : Promise.resolve(),
    ]);
  };

  return (
    <div className="page-stack page-enter ledger-page">
      <NetworkDetailHeader
        networkId={networkId}
        displayName={network?.displayName ?? networkId}
        eyebrow="账本浏览器"
        title="区块与交易明文"
        description="直接从已加入通道的 Peer 读取最终账本，解析交易、链码调用、背书和公共读写集。"
        refreshing={channelsQuery.isFetching || blocksQuery.isFetching || blockQuery.isFetching}
        onRefresh={refresh}
      />

      {channelsQuery.isPending ? (
        <LedgerState busy title="正在发现通道" description="正在询问各 Peer 已加入的 Fabric 通道。" />
      ) : channelsQuery.isError ? (
        <LedgerState
          error
          title="账本暂时不可用"
          description={getApiErrorMessage(
            channelsQuery.error,
            '无法读取账本，请确认网络已启动且 Peer 服务可达。',
          )}
          action={<button className="secondary-action" type="button" onClick={refresh}>重试</button>}
        />
      ) : channelsQuery.data.items.length === 0 ? (
        <LedgerState
          title="没有发现已加入的通道"
          description="控制平面不会猜测通道名称；请先让至少一个已配置 Peer 加入通道。"
        />
      ) : (
        <>
          <section className="ledger-channel-console" aria-label="账本通道摘要">
            <div className="ledger-channel-switcher">
              <span className="eyebrow">动态发现的通道</span>
              <div>
                {channelsQuery.data.items.map((item) => (
                  <button
                    type="button"
                    className={item.name === selectedChannel ? 'is-selected' : undefined}
                    key={item.name}
                    onClick={() => selectChannel(item.name)}
                  >
                    <span aria-hidden="true" />
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
            {channel ? (
              <div className="ledger-channel-metrics">
                <LedgerMetric icon={Blocks} label="账本高度" value={formatInteger(channel.height)} />
                <LedgerMetric
                  icon={Hash}
                  label="最新区块"
                  value={channel.currentBlockNumber ? `#${formatInteger(channel.currentBlockNumber)}` : '空账本'}
                />
                <LedgerMetric icon={RadioTower} label="观察 Peer" value={channel.observedPeer} mono />
                <LedgerMetric icon={Clock3} label="观察时间" value={formatDateTimeZh(channel.observedAt)} />
              </div>
            ) : null}
          </section>

          <div className="ledger-workbench">
            <Panel
              eyebrow={selectedChannel ? `通道 ${selectedChannel}` : '区块流'}
              title="最近区块"
              className="ledger-block-panel"
              action={
                <span className="ledger-page-indicator">
                  第 {pageIndex + 1} 页 · 每页 {pageSize} 个
                </span>
              }
            >
              {blocksQuery.isPending ? (
                <LedgerState compact busy title="正在读取区块" description="从 Peer QSCC 获取最终提交的区块。" />
              ) : blocksQuery.isError ? (
                <LedgerState
                  compact
                  error
                  title="区块列表不可用"
                  description={getApiErrorMessage(blocksQuery.error, '无法读取该通道的区块。')}
                />
              ) : blocksQuery.data.items.length === 0 ? (
                <LedgerState compact title="当前页没有区块" description="该通道可能尚未生成区块。" />
              ) : (
                <div className="ledger-block-list">
                  {blocksQuery.data.items.map((block) => (
                    <BlockListItem
                      key={block.number}
                      block={block}
                      selected={block.number === selectedBlockNumber}
                      onSelect={() => setSelectedBlockNumber(block.number)}
                    />
                  ))}
                </div>
              )}
              <div className="ledger-pagination">
                <button
                  className="secondary-action"
                  type="button"
                  disabled={pageIndex === 0 || blocksQuery.isFetching}
                  onClick={() => setPageIndex((current) => current - 1)}
                >
                  <ArrowLeft size={14} />更新区块
                </button>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={!hasOlderBlocks || blocksQuery.isFetching}
                  onClick={showOlderBlocks}
                >
                  更早区块<ArrowRight size={14} />
                </button>
              </div>
            </Panel>

            <Panel
              eyebrow={selectedBlockNumber ? `BLOCK ${selectedBlockNumber}` : '区块详情'}
              title={selectedBlockNumber ? `区块 #${formatInteger(selectedBlockNumber)}` : '选择一个区块'}
              className="ledger-detail-panel"
            >
              {blockQuery.isPending && selectedBlockNumber ? (
                <LedgerState compact busy title="正在解析区块" description="正在解码 Fabric protobuf 数据。" />
              ) : blockQuery.isError ? (
                <LedgerState
                  compact
                  error
                  title="区块详情不可用"
                  description={getApiErrorMessage(blockQuery.error, '无法解码所选区块。')}
                />
              ) : blockQuery.data ? (
                <BlockDetail block={blockQuery.data} />
              ) : (
                <LedgerState compact title="尚未选择区块" description="从左侧区块流中选择一个区块。" />
              )}
            </Panel>
          </div>

          <div className="ledger-privacy-note" role="note">
            <ShieldCheck size={17} />
            <div>
              <strong>公共账本可见性边界</strong>
              <span>
                页面会展示公共状态的明文读写值。Transient 输入不会写入区块；私有数据集合仅能从公共区块恢复集合名、计数和哈希摘要，无法恢复私有明文。
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LedgerMetric({
  icon: Icon,
  label,
  value,
  mono = false,
}: {
  icon: typeof Blocks;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="ledger-metric">
      <Icon size={16} />
      <span>{label}</span>
      <strong className={mono ? 'mono-value' : undefined}>{value}</strong>
    </div>
  );
}

function BlockListItem({
  block,
  selected,
  onSelect,
}: {
  block: LedgerBlockSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`ledger-block-card${selected ? ' is-selected' : ''}`}
      type="button"
      onClick={onSelect}
    >
      <span className="ledger-block-card__number">#{formatInteger(block.number)}</span>
      <span className="ledger-block-card__time">{formatCompactDateTime(block.timestamp)}</span>
      <span className="ledger-block-card__tx">
        {block.transactionCount} 笔交易
        {block.invalidTransactionCount > 0 ? (
          <em>{block.invalidTransactionCount} 笔无效</em>
        ) : (
          <em className="is-valid">全部有效</em>
        )}
      </span>
      <span className="ledger-block-card__chaincodes">
        {block.chaincodes.length > 0 ? block.chaincodes.join(' · ') : '系统或配置交易'}
      </span>
    </button>
  );
}

function BlockDetail({ block }: { block: LedgerBlock }) {
  return (
    <div className="ledger-block-detail">
      <dl className="ledger-block-facts">
        <div><dt>通道</dt><dd>{block.channelName}</dd></div>
        <div><dt>交易</dt><dd>{block.transactionCount}</dd></div>
        <div><dt>有效 / 无效</dt><dd>{block.validTransactionCount} / {block.invalidTransactionCount}</dd></div>
        <div><dt>原始大小</dt><dd>{formatBytes(block.rawSize)}</dd></div>
        <div className="is-wide"><dt>数据哈希</dt><dd className="mono-value">{block.dataHash || '创世区块未提供'}</dd></div>
        <div className="is-wide"><dt>前序哈希</dt><dd className="mono-value">{block.previousHash || '无（创世区块）'}</dd></div>
      </dl>

      <div className="ledger-transaction-heading">
        <div>
          <span className="eyebrow">交易信封</span>
          <h3>{block.transactions.length} 笔已解码交易</h3>
        </div>
        <span>{formatDateTimeZh(block.timestamp)}</span>
      </div>

      {block.transactions.length === 0 ? (
        <div className="ledger-inline-empty">该区块不包含交易信封。</div>
      ) : (
        <div className="ledger-transactions">
          {block.transactions.map((transaction) => (
            <TransactionDetail
              transaction={transaction}
              key={`${transaction.index}-${transaction.txId ?? 'unknown'}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TransactionDetail({ transaction }: { transaction: LedgerTransaction }) {
  const [open, setOpen] = useState(transaction.index === 0);

  return (
    <details
      className="ledger-transaction"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={`ledger-validation ledger-validation--${transaction.valid ? 'valid' : 'invalid'}`}>
          {transaction.valid ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        </span>
        <span>
          <strong>{transaction.txId ?? `交易 ${transaction.index + 1}`}</strong>
          <small>{getTransactionTypeLabel(transaction.typeLabel)} · {formatDateTimeZh(transaction.timestamp)}</small>
        </span>
        <em>{getValidationLabel(transaction.validationLabel)}</em>
      </summary>

      <div className="ledger-transaction__body">
        <dl className="ledger-transaction-facts">
          <div><dt>Creator MSP</dt><dd>{transaction.creator?.mspId ?? '未解析'}</dd></div>
          <div><dt>通道 ID</dt><dd>{transaction.channelId ?? '未解析'}</dd></div>
          <div><dt>验证代码</dt><dd>{transaction.validationCode} · {getValidationLabel(transaction.validationLabel)}</dd></div>
          <div><dt>证书主体</dt><dd>{transaction.creator?.certificateSubject ?? '未解析'}</dd></div>
        </dl>

        {transaction.decodeError ? <DecodeWarning message={transaction.decodeError} /> : null}
        {transaction.actions.length === 0 ? (
          <div className="ledger-inline-empty">该交易不包含可解析的链码动作。</div>
        ) : (
          transaction.actions.map((action, actionIndex) => (
            <section className="ledger-action" key={`${transaction.index}-${actionIndex}`}>
              <header>
                <div className="ledger-action__icon"><Code2 size={17} /></div>
                <div>
                  <span>{action.chaincodeName ?? '未知链码'}{action.chaincodeVersion ? ` · ${action.chaincodeVersion}` : ''}</span>
                  <strong>{action.functionName ?? '未解析函数'}</strong>
                </div>
                <span className="ledger-response-status">响应 {action.responseStatus ?? '—'}</span>
              </header>

              {action.decodeError ? <DecodeWarning message={action.decodeError} /> : null}

              <div className="ledger-section-block">
                <div className="ledger-section-title"><Braces size={15} /><strong>调用参数</strong><span>{action.arguments.length}</span></div>
                {action.arguments.length === 0 ? (
                  <div className="ledger-inline-empty">没有链码参数。</div>
                ) : (
                  <div className="ledger-argument-list">
                    {action.arguments.map((argument, index) => (
                      <div className="ledger-argument" key={index}>
                        <span>ARG {index + 1}</span>
                        <DecodedValue value={argument} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="ledger-section-grid">
                <div className="ledger-section-block">
                  <div className="ledger-section-title"><FileJson size={15} /><strong>链码响应</strong></div>
                  {action.responseMessage ? <p className="ledger-response-message">{action.responseMessage}</p> : null}
                  {action.responsePayload ? <DecodedValue value={action.responsePayload} /> : <div className="ledger-inline-empty">响应没有载荷。</div>}
                </div>
                <div className="ledger-section-block">
                  <div className="ledger-section-title"><ShieldCheck size={15} /><strong>背书组织</strong><span>{action.endorsements.length}</span></div>
                  {action.endorsements.length === 0 ? (
                    <div className="ledger-inline-empty">没有背书记录。</div>
                  ) : (
                    <div className="ledger-endorsements">
                      {action.endorsements.map((endorsement, index) => (
                        <span key={`${endorsement.mspId ?? 'unknown'}-${index}`}>
                          <ShieldCheck size={13} />{endorsement.mspId ?? '未知 MSP'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {action.event ? (
                <div className="ledger-event">
                  <Fingerprint size={16} />
                  <div><span>链码事件 · {action.event.chaincodeId}</span><strong>{action.event.eventName}</strong></div>
                  <DecodedValue value={action.event.payload} compact />
                </div>
              ) : null}

              <div className="ledger-section-block">
                <div className="ledger-section-title"><Database size={15} /><strong>公共状态读写集</strong><span>{action.readWriteSets.length}</span></div>
                {action.readWriteSets.length === 0 ? (
                  <div className="ledger-inline-empty">该动作没有公共状态读写集。</div>
                ) : (
                  <div className="ledger-rwsets">
                    {action.readWriteSets.map((rwset) => <ReadWriteSet rwset={rwset} key={rwset.namespace} />)}
                  </div>
                )}
              </div>
            </section>
          ))
        )}
      </div>
    </details>
  );
}

function ReadWriteSet({ rwset }: { rwset: LedgerNamespaceReadWriteSet }) {
  const [open, setOpen] = useState(rwset.writes.length > 0);

  return (
    <details
      className="ledger-rwset"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span><Database size={14} />{rwset.namespace}</span>
        <em>{rwset.reads.length} 读 · {rwset.writes.length} 写 · {rwset.privateCollections.length} 私有集合摘要</em>
      </summary>
      <div className="ledger-rwset__body">
        {rwset.decodeError ? <DecodeWarning message={rwset.decodeError} /> : null}
        {rwset.reads.length > 0 ? (
          <div className="ledger-state-group">
            <span>读取</span>
            {rwset.reads.map((read, index) => (
              <div className="ledger-state-row" key={`${read.key}-${index}`}>
                <code>{read.key}</code>
                <small>{read.version ? `版本 ${read.version.blockNumber}:${read.version.transactionNumber}` : '无版本'}</small>
              </div>
            ))}
          </div>
        ) : null}
        {rwset.writes.length > 0 ? (
          <div className="ledger-state-group">
            <span>写入</span>
            {rwset.writes.map((write, index) => (
              <div className="ledger-state-write" key={`${write.key}-${index}`}>
                <header><code>{write.key}</code><span>{write.isDelete ? '删除' : '更新'}</span></header>
                <DecodedValue value={write.value} />
              </div>
            ))}
          </div>
        ) : null}
        {rwset.privateCollections.length > 0 ? (
          <div className="ledger-state-group">
            <span>私有集合哈希摘要</span>
            {rwset.privateCollections.map((collection) => (
              <div className="ledger-private-summary" key={collection.collectionName}>
                <div><ShieldCheck size={14} /><strong>{collection.collectionName}</strong></div>
                <span>{collection.readHashCount} 读哈希 · {collection.writeHashCount} 写哈希</span>
                <code>{collection.pvtRwsetHash}</code>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function DecodedValue({ value, compact = false }: { value: LedgerDecodedValue; compact?: boolean }) {
  const visibleValue = useMemo(() => {
    if (value.encoding === 'empty') return '空值';
    if (value.json !== null) return JSON.stringify(value.json, null, 2);
    if (value.text !== null) return value.text;
    return value.base64;
  }, [value]);

  return (
    <div className={`ledger-value${compact ? ' ledger-value--compact' : ''}`}>
      <div className="ledger-value__meta">
        <span>{getEncodingLabel(value.encoding)}</span>
        <span>{formatBytes(value.byteLength)}</span>
      </div>
      <pre>{visibleValue}</pre>
      {!compact && value.encoding !== 'empty' ? (
        <details>
          <summary>查看 base64 原值</summary>
          <code>{value.base64}</code>
        </details>
      ) : null}
    </div>
  );
}

function DecodeWarning({ message }: { message: string }) {
  return <div className="ledger-decode-warning">部分 protobuf 内容无法解析：{message}</div>;
}

function LedgerState({
  title,
  description,
  error = false,
  compact = false,
  busy = false,
  action,
}: {
  title: string;
  description: string;
  error?: boolean;
  compact?: boolean;
  busy?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className={`query-state ledger-state${error ? ' query-state--error' : ''}${compact ? ' ledger-state--compact' : ''}`} role={error ? 'alert' : 'status'}>
      {busy ? <span className="query-state__spinner" aria-hidden="true" /> : null}
      <div><h3>{title}</h3><p>{description}</p></div>
      {action}
    </div>
  );
}

function formatInteger(value: string): string {
  try {
    return BigInt(value).toLocaleString('zh-CN');
  } catch {
    return value;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatCompactDateTime(value: string | null): string {
  if (!value) return '无时间戳';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function getEncodingLabel(encoding: LedgerDecodedValue['encoding']): string {
  return { empty: '空值', utf8: 'UTF-8', json: 'JSON', base64: '二进制 / base64' }[encoding];
}

function getTransactionTypeLabel(label: string): string {
  return {
    ENDORSER_TRANSACTION: '链码交易',
    CONFIG: '通道配置交易',
    CONFIG_UPDATE: '配置更新交易',
    ORDERER_TRANSACTION: '排序交易',
    DELIVER_SEEK_INFO: '区块投递请求',
  }[label] ?? label;
}

function getValidationLabel(label: string): string {
  return {
    VALID: '有效',
    NOT_VALIDATED: '未验证',
    MVCC_READ_CONFLICT: 'MVCC 读冲突',
    PHANTOM_READ_CONFLICT: '幻读冲突',
    ENDORSEMENT_POLICY_FAILURE: '背书策略失败',
    INVALID_OTHER_REASON: '其他无效原因',
  }[label] ?? label;
}
