import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CreateManagedNetworkRequestSchema, DEFAULT_FABRIC_VERSION } from '@plus-fabric/shared';
import { useMutation } from '@tanstack/react-query';
import { Boxes, Database, GitBranch, Network, Plus, ShieldAlert, Trash2, X } from 'lucide-react';

import { createManagedNetwork } from '../../api/control-plane';
import { getApiErrorMessage } from '../../i18n/zh-CN';

type OrganizationDraft = {
  key: string;
  name: string;
  mspId: string;
  peerCount: number | '';
};

type ChannelDraft = {
  key: string;
  name: string;
  memberOrganizationKeys: string[];
};

type ManagedNetworkDialogProps = {
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onCreated(): Promise<void>;
};

let draftSequence = 0;

function nextDraftKey(prefix: string): string {
  draftSequence += 1;
  return `${prefix}-${draftSequence}`;
}

export function ManagedNetworkDialog({
  returnFocusRef,
  onClose,
  onCreated,
}: ManagedNetworkDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [portMode, setPortMode] = useState<'automatic' | 'manual'>('automatic');
  const [identity, setIdentity] = useState({
    id: '',
    displayName: '',
    domain: '',
    ordererCount: 1 as number | '',
    preferredPortStart: '',
    fabricVersion: '',
    fabricCaVersion: '',
    stateDatabase: 'leveldb' as 'leveldb' | 'couchdb',
    consensusType: 'etcdraft' as 'etcdraft' | 'solo',
    batchTimeoutSeconds: 2 as number | '',
    maxMessageCount: 10 as number | '',
    absoluteMaxBytesMiB: 99 as number | '',
    preferredMaxBytesKiB: 512 as number | '',
  });
  const [organizations, setOrganizations] = useState<OrganizationDraft[]>(() => [
    { key: nextDraftKey('organization'), name: '', mspId: '', peerCount: 1 },
  ]);
  const [channels, setChannels] = useState<ChannelDraft[]>(() => [
    { key: nextDraftKey('channel'), name: '', memberOrganizationKeys: [] },
  ]);
  const createMutation = useMutation({
    mutationFn: createManagedNetwork,
    onSuccess: onCreated,
  });

  const peerCount = useMemo(
    () =>
      organizations.reduce(
        (total, organization) => total + (organization.peerCount === '' ? 0 : organization.peerCount),
        0,
      ),
    [organizations],
  );
  const ordererCount = identity.ordererCount === '' ? 0 : identity.ordererCount;
  const couchdbNodeCount = identity.stateDatabase === 'couchdb' ? peerCount : 0;
  const reservedPortCount =
    ordererCount * 3 + organizations.length + 1 + peerCount * 3 + couchdbNodeCount;
  const configuredFabricMajor = Number(
    (identity.fabricVersion || DEFAULT_FABRIC_VERSION).split('.')[0],
  );
  const soloUnavailable = ordererCount !== 1 || configuredFabricMajor >= 3;

  useEffect(() => {
    if (identity.consensusType === 'solo' && soloUnavailable) {
      setIdentity((current) => ({ ...current, consensusType: 'etcdraft' }));
    }
  }, [identity.consensusType, soloUnavailable]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : returnFocusRef.current;
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => (previousFocus ?? returnFocusRef.current)?.focus();
  }, [returnFocusRef]);

  const close = () => {
    if (!createMutation.isPending) onClose();
  };

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const addOrganization = () => {
    setOrganizations((current) => [
      ...current,
      { key: nextDraftKey('organization'), name: '', mspId: '', peerCount: 1 },
    ]);
  };

  const removeOrganization = (key: string) => {
    setOrganizations((current) => current.filter((organization) => organization.key !== key));
    setChannels((current) =>
      current.map((channel) => ({
        ...channel,
        memberOrganizationKeys: channel.memberOrganizationKeys.filter(
          (organizationKey) => organizationKey !== key,
        ),
      })),
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(null);
    createMutation.reset();

    const organizationNames = new Map(
      organizations.map((organization) => [organization.key, organization.name.trim()]),
    );
    const parsed = CreateManagedNetworkRequestSchema.safeParse({
      id: identity.id,
      displayName: identity.displayName,
      domain: identity.domain,
      ordererCount: Number(identity.ordererCount),
      peerOrganizations: organizations.map(({ name, mspId, peerCount: count }) => ({
        name,
        mspId,
        peerCount: Number(count),
      })),
      channels: channels.map((channel) => ({
        name: channel.name,
        memberOrganizations: channel.memberOrganizationKeys
          .map((key) => organizationNames.get(key) ?? '')
          .filter(Boolean),
      })),
      preferredPortStart:
        portMode === 'manual' && identity.preferredPortStart
          ? Number(identity.preferredPortStart)
          : null,
      fabricVersion: identity.fabricVersion || null,
      fabricCaVersion: identity.fabricCaVersion || null,
      stateDatabase: identity.stateDatabase,
      ordererConfiguration: {
        consensusType: identity.consensusType,
        batchTimeoutSeconds: Number(identity.batchTimeoutSeconds),
        maxMessageCount: Number(identity.maxMessageCount),
        absoluteMaxBytesMiB: Number(identity.absoluteMaxBytesMiB),
        preferredMaxBytesKiB: Number(identity.preferredMaxBytesKiB),
      },
    });
    if (!parsed.success) {
      setValidationError(getValidationMessage(parsed.error.issues[0]?.path[0]));
      return;
    }
    createMutation.mutate(parsed.data);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="import-dialog managed-network-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-network-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <div className="import-dialog__heading">
          <div>
            <span className="eyebrow">托管工作区</span>
            <h2 id="create-network-title">创建 Fabric 网络</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭创建对话框" onClick={close}>
            <X size={18} />
          </button>
        </div>

        <form className="managed-network-form" onSubmit={submit} aria-busy={createMutation.isPending}>
          <div className="managed-network-summary" aria-label="网络规模摘要">
            <span><strong>{organizations.length}</strong> Peer 组织</span>
            <span><strong>{peerCount}</strong> Peer 节点</span>
            <span><strong>{ordererCount}</strong> Orderer 节点</span>
            <span><strong>{couchdbNodeCount}</strong> CouchDB 节点</span>
            <span><strong>{channels.length}</strong> 通道</span>
            <span><strong>{reservedPortCount}</strong> 规划端口</span>
          </div>

          <fieldset className="managed-form-section">
            <legend><Boxes size={16} /> 网络标识</legend>
            <div className="managed-form-grid">
              <label>
                <span>网络 ID</span>
                <input
                  required
                  minLength={3}
                  maxLength={40}
                  pattern="[a-z][a-z0-9-]*[a-z0-9]"
                  title="使用小写字母、数字和连字符，长度为 3 到 40 个字符"
                  value={identity.id}
                  onChange={(event) => setIdentity({ ...identity, id: event.target.value })}
                />
                <small>用于工作区、Docker network 和 Compose project。</small>
              </label>
              <label>
                <span>显示名称</span>
                <input
                  required
                  maxLength={100}
                  value={identity.displayName}
                  onChange={(event) => setIdentity({ ...identity, displayName: event.target.value })}
                />
              </label>
              <label>
                <span>网络域名</span>
                <input
                  required
                  value={identity.domain}
                  onChange={(event) => setIdentity({ ...identity, domain: event.target.value })}
                />
              </label>
              <label>
                <span>Orderer 数量</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={7}
                  value={identity.ordererCount}
                  onChange={(event) =>
                    setIdentity({
                      ...identity,
                      ordererCount: event.target.value === '' ? '' : event.target.valueAsNumber,
                    })
                  }
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="managed-form-section">
            <legend><GitBranch size={16} /> Orderer 共识与出块</legend>
            <div className="managed-feature-options" role="group" aria-label="Orderer 共识类型">
              <button
                type="button"
                className={identity.consensusType === 'etcdraft' ? 'is-active' : ''}
                aria-pressed={identity.consensusType === 'etcdraft'}
                onClick={() => setIdentity({ ...identity, consensusType: 'etcdraft' })}
              >
                <span className="managed-feature-options__signal" aria-hidden="true" />
                <strong>Raft / etcdraft</strong>
                <small>默认共识，支持多 Orderer，适用于当前 Fabric 2.x 托管网络。</small>
              </button>
              <button
                type="button"
                className={identity.consensusType === 'solo' ? 'is-active' : ''}
                aria-pressed={identity.consensusType === 'solo'}
                disabled={soloUnavailable}
                title={
                  configuredFabricMajor >= 3
                    ? 'Fabric 3.x 已不支持 Solo'
                    : ordererCount !== 1
                      ? 'Solo 仅支持一个 Orderer'
                      : '仅建议本地实验使用'
                }
                onClick={() => setIdentity({ ...identity, consensusType: 'solo' })}
              >
                <span className="managed-feature-options__signal" aria-hidden="true" />
                <strong>Solo</strong>
                <small>单节点实验共识，无容错能力；Fabric 3.x 不支持。</small>
              </button>
            </div>
            <div className="managed-orderer-parameters">
              <label>
                <span>批次超时</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={300}
                  value={identity.batchTimeoutSeconds}
                  onChange={(event) =>
                    setIdentity({
                      ...identity,
                      batchTimeoutSeconds:
                        event.target.value === '' ? '' : event.target.valueAsNumber,
                    })
                  }
                />
                <small>秒，达到超时后切出新区块。</small>
              </label>
              <label>
                <span>最大交易数</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={10000}
                  value={identity.maxMessageCount}
                  onChange={(event) =>
                    setIdentity({
                      ...identity,
                      maxMessageCount:
                        event.target.value === '' ? '' : event.target.valueAsNumber,
                    })
                  }
                />
                <small>单个区块允许的最大消息数量。</small>
              </label>
              <label>
                <span>绝对大小上限</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={99}
                  value={identity.absoluteMaxBytesMiB}
                  onChange={(event) =>
                    setIdentity({
                      ...identity,
                      absoluteMaxBytesMiB:
                        event.target.value === '' ? '' : event.target.valueAsNumber,
                    })
                  }
                />
                <small>MiB，任何批次都不能超过该值。</small>
              </label>
              <label>
                <span>首选大小上限</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={101376}
                  value={identity.preferredMaxBytesKiB}
                  onChange={(event) =>
                    setIdentity({
                      ...identity,
                      preferredMaxBytesKiB:
                        event.target.value === '' ? '' : event.target.valueAsNumber,
                    })
                  }
                />
                <small>KiB，必须小于或等于绝对大小上限。</small>
              </label>
            </div>
            <p className={`managed-consensus-note${identity.consensusType === 'solo' ? ' is-warning' : ''}`}>
              {identity.consensusType === 'solo'
                ? 'Solo 仅用于本地实验，不提供节点故障容错。'
                : 'Raft 建议使用奇数个 Orderer，以获得明确的多数派。'}
            </p>
          </fieldset>

          <fieldset className="managed-form-section">
            <legend><Database size={16} /> 状态数据库</legend>
            <div className="managed-feature-options" role="group" aria-label="Peer 状态数据库">
              <button
                type="button"
                className={identity.stateDatabase === 'leveldb' ? 'is-active' : ''}
                aria-pressed={identity.stateDatabase === 'leveldb'}
                onClick={() => setIdentity({ ...identity, stateDatabase: 'leveldb' })}
              >
                <span className="managed-feature-options__signal" aria-hidden="true" />
                <strong>LevelDB</strong>
                <small>默认内嵌数据库，不增加容器和宿主机端口，适合轻量实验网络。</small>
              </button>
              <button
                type="button"
                className={identity.stateDatabase === 'couchdb' ? 'is-active' : ''}
                aria-pressed={identity.stateDatabase === 'couchdb'}
                onClick={() => setIdentity({ ...identity, stateDatabase: 'couchdb' })}
              >
                <span className="managed-feature-options__signal" aria-hidden="true" />
                <strong>CouchDB</strong>
                <small>每个 Peer 配套独立容器和数据卷，支持富 JSON 查询与索引。</small>
              </button>
            </div>
          </fieldset>

          <fieldset className="managed-form-section">
            <legend><Network size={16} /> Peer 组织与节点</legend>
            <button
              className="secondary-action compact-action managed-form-section__add"
              type="button"
              onClick={addOrganization}
            >
              <Plus size={14} /> 添加组织
            </button>
            <div className="managed-repeat-list">
              {organizations.map((organization, index) => (
                <div className="managed-organization-row" key={organization.key}>
                  <span className="managed-row-index">{String(index + 1).padStart(2, '0')}</span>
                  <label>
                    <span>组织名称</span>
                    <input
                      required
                      maxLength={32}
                      pattern="[a-z][a-z0-9-]*"
                      value={organization.name}
                      onChange={(event) =>
                        setOrganizations((current) =>
                          current.map((item) =>
                            item.key === organization.key ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    <span>MSP ID</span>
                    <input
                      required
                      maxLength={64}
                      pattern="[A-Za-z][A-Za-z0-9]*MSP"
                      value={organization.mspId}
                      onChange={(event) =>
                        setOrganizations((current) =>
                          current.map((item) =>
                            item.key === organization.key ? { ...item, mspId: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    <span>Peer 数量</span>
                    <input
                      required
                      type="number"
                      min={1}
                      max={10}
                      value={organization.peerCount}
                      onChange={(event) =>
                        setOrganizations((current) =>
                          current.map((item) =>
                            item.key === organization.key
                              ? {
                                  ...item,
                                  peerCount:
                                    event.target.value === '' ? '' : event.target.valueAsNumber,
                                }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    className="icon-button managed-row-remove"
                    type="button"
                    aria-label={`删除第 ${index + 1} 个组织`}
                    title="删除组织"
                    disabled={organizations.length === 1}
                    onClick={() => removeOrganization(organization.key)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="managed-form-section">
            <legend><Network size={16} /> 通道与成员</legend>
            <button
              className="secondary-action compact-action managed-form-section__add"
              type="button"
              onClick={() =>
                setChannels((current) => [
                  ...current,
                  { key: nextDraftKey('channel'), name: '', memberOrganizationKeys: [] },
                ])
              }
            >
              <Plus size={14} /> 添加通道
            </button>
            <div className="managed-repeat-list">
              {channels.map((channel, index) => (
                <div className="managed-channel-row" key={channel.key}>
                  <div className="managed-channel-row__identity">
                    <span className="managed-row-index">{String(index + 1).padStart(2, '0')}</span>
                    <label>
                      <span>通道名称</span>
                      <input
                        required
                        maxLength={249}
                        pattern="[a-z][a-z0-9.-]*"
                        value={channel.name}
                        onChange={(event) =>
                          setChannels((current) =>
                            current.map((item) =>
                              item.key === channel.key ? { ...item, name: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      className="icon-button managed-row-remove"
                      type="button"
                      aria-label={`删除第 ${index + 1} 个通道`}
                      title="删除通道"
                      disabled={channels.length === 1}
                      onClick={() =>
                        setChannels((current) => current.filter((item) => item.key !== channel.key))
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="managed-member-picker" role="group" aria-label="通道成员组织">
                    {organizations.map((organization, organizationIndex) => {
                      const checked = channel.memberOrganizationKeys.includes(organization.key);
                      return (
                        <label key={organization.key}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setChannels((current) =>
                                current.map((item) =>
                                  item.key === channel.key
                                    ? {
                                        ...item,
                                        memberOrganizationKeys: checked
                                          ? item.memberOrganizationKeys.filter(
                                              (key) => key !== organization.key,
                                            )
                                          : [...item.memberOrganizationKeys, organization.key],
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                          <span>{organization.name || `组织 ${organizationIndex + 1}`}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="managed-form-section">
            <legend><Boxes size={16} /> 端口与版本</legend>
            <div className="managed-port-control">
              <div className="segmented-control" aria-label="端口规划方式">
                <button
                  type="button"
                  className={portMode === 'automatic' ? 'is-active' : ''}
                  aria-pressed={portMode === 'automatic'}
                  onClick={() => setPortMode('automatic')}
                >
                  自动规划
                </button>
                <button
                  type="button"
                  className={portMode === 'manual' ? 'is-active' : ''}
                  aria-pressed={portMode === 'manual'}
                  onClick={() => setPortMode('manual')}
                >
                  指定起始端口
                </button>
              </div>
              <label>
                <span>起始端口</span>
                <input
                  type="number"
                  min={10000}
                  max={60000}
                  required={portMode === 'manual'}
                  disabled={portMode === 'automatic'}
                  value={identity.preferredPortStart}
                  onChange={(event) =>
                    setIdentity({ ...identity, preferredPortStart: event.target.value })
                  }
                />
              </label>
              <label>
                <span>Fabric 版本</span>
                <input
                  value={identity.fabricVersion}
                  onChange={(event) => setIdentity({ ...identity, fabricVersion: event.target.value })}
                />
              </label>
              <label>
                <span>Fabric CA 版本</span>
                <input
                  value={identity.fabricCaVersion}
                  onChange={(event) => setIdentity({ ...identity, fabricCaVersion: event.target.value })}
                />
              </label>
            </div>
          </fieldset>

          {validationError || createMutation.isError ? (
            <div className="form-error" role="alert">
              <ShieldAlert size={16} />
              <span>
                {validationError ?? getApiErrorMessage(createMutation.error, '无法创建该网络。')}
              </span>
            </div>
          ) : null}

          <div className="import-form__actions managed-network-form__actions">
            <button className="secondary-action" type="button" onClick={close} disabled={createMutation.isPending}>
              取消
            </button>
            <button className="primary-action" type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? '正在创建…' : '创建网络'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function getValidationMessage(path: PropertyKey | undefined): string {
  const labels: Record<string, string> = {
    id: '网络 ID',
    displayName: '显示名称',
    domain: '网络域名',
    ordererCount: 'Orderer 数量',
    peerOrganizations: 'Peer 组织',
    channels: '通道及成员组织',
    preferredPortStart: '端口规划',
    fabricVersion: 'Fabric 版本',
    fabricCaVersion: 'Fabric CA 版本',
    stateDatabase: '状态数据库',
    ordererConfiguration: 'Orderer 共识与出块',
  };
  return `请检查${labels[String(path)] ?? '网络'}配置，字段可能为空、重复或引用无效。`;
}
