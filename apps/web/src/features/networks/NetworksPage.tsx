import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowRight, Boxes, Plus, ShieldAlert, X } from 'lucide-react';
import type { NetworkDiscoveryCandidate } from '@plus-fabric/shared';
import { Link } from 'react-router-dom';

import { getNetworks, importNetwork } from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import { ManagedNetworkDialog } from './ManagedNetworkDialog';
import { NetworkDiscoveriesPanel } from './NetworkDiscoveriesPanel';
import {
  getApiErrorMessage,
  getManagementModeLabel,
  getNetworkStatusLabel,
} from '../../i18n/zh-CN';

export function NetworksPage() {
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const importDialogRef = useRef<HTMLElement>(null);
  const [form, setForm] = useState({
    id: '',
    displayName: '',
    workspaceRoot: '',
    configPath: 'config/orgs.yaml',
    composeProject: '',
    fabricVersion: '',
    fabricCaVersion: '',
  });
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    refetchInterval: 10_000,
  });
  const networks = networksQuery.data?.items ?? [];
  const total = networksQuery.data?.total;
  const importMutation = useMutation({
    mutationFn: importNetwork,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['networks'] });
      await queryClient.invalidateQueries({ queryKey: ['network-discoveries'] });
      setImportOpen(false);
      setForm({
        id: '',
        displayName: '',
        workspaceRoot: '',
        configPath: 'config/orgs.yaml',
        composeProject: '',
        fabricVersion: '',
        fabricCaVersion: '',
      });
    },
  });

  useEffect(() => {
    if (!importOpen) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : importButtonRef.current;
    const dialog = importDialogRef.current;
    dialog?.querySelector<HTMLElement>('input')?.focus();

    return () => {
      (previousFocus ?? importButtonRef.current)?.focus();
    };
  }, [importOpen]);

  const closeImportDialog = () => {
    if (!importMutation.isPending) setImportOpen(false);
  };

  const openImportDialog = (candidate?: NetworkDiscoveryCandidate) => {
    importMutation.reset();
    if (candidate) {
      setForm({
        id: normalizeNetworkId(candidate.manifest.networkId),
        displayName: candidate.manifest.displayName,
        workspaceRoot: candidate.manifest.workspaceRoot,
        configPath: relativeConfigPath(
          candidate.manifest.workspaceRoot,
          candidate.manifest.configPath,
        ),
        composeProject: candidate.manifest.composeProject,
        fabricVersion: candidate.manifest.fabricVersion ?? '',
        fabricCaVersion: candidate.manifest.fabricCaVersion ?? '',
      });
    }
    setImportOpen(true);
  };

  const trapDialogFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeImportDialog();
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

  const submitImport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    importMutation.mutate({
      id: form.id,
      displayName: form.displayName,
      driver: 'fabric-compose',
      workspaceRoot: form.workspaceRoot,
      configPath: form.configPath,
      composeProject: form.composeProject,
      fabricVersion: form.fabricVersion || null,
      fabricCaVersion: form.fabricCaVersion || null,
    });
  };

  return (
    <div className="page-stack page-enter">
      <section className="page-heading">
        <div>
          <span className="eyebrow">网络注册表</span>
          <h1>集中管理相互隔离的网络</h1>
          <p>每个网络独立拥有工作区、运行命名空间、凭据、版本和运维历史。</p>
        </div>
        <div className="page-heading__actions">
          <button
            ref={importButtonRef}
            className="secondary-action"
            type="button"
            onClick={() => openImportDialog()}
          >
            <ArrowDownToLine size={16} /> 导入网络
          </button>
          <button
            ref={createButtonRef}
            className="primary-action"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} /> 创建网络
          </button>
        </div>
      </section>

      <div className="registry-notice">
        <ShieldAlert size={18} />
        <span>
          平台只读取 network.sh 写入的标准发现清单，不会自动注册或执行本地网络；导入仍需人工确认和路径校验。
        </span>
      </div>

      <NetworkDiscoveriesPanel onImport={openImportDialog} />

      <Panel
        eyebrow="网络清单"
        title={
          networksQuery.isPending
            ? '正在加载已注册网络'
            : networksQuery.isError
              ? '网络注册表不可用'
              : `已注册 ${total ?? 0} 个网络`
        }
      >
        {networksQuery.isPending ? (
          <div className="network-table-empty" role="status" aria-live="polite">
            <span className="query-state__spinner" aria-hidden="true" />
            <h3>正在加载网络定义</h3>
          </div>
        ) : networksQuery.isError ? (
          <div className="network-table-empty network-table-empty--error">
            <ShieldAlert size={30} strokeWidth={1.35} />
            <h3>网络注册表请求失败</h3>
            <p>
              {getApiErrorMessage(networksQuery.error, '无法连接控制平面 API。')}
            </p>
            <button className="secondary-action" type="button" onClick={() => networksQuery.refetch()}>
              重新请求
            </button>
          </div>
        ) : networks.length === 0 ? (
          <div className="network-table-empty">
            <Boxes size={30} strokeWidth={1.35} />
            <h3>暂无网络定义</h3>
            <p>创建托管网络，或导入已有 Fabric 工作区。</p>
          </div>
        ) : (
          <div className="network-list" role="list">
            {networks.map((network) => (
              <article className="network-row" key={network.id} role="listitem">
                <div
                  className={`network-row__status network-row__status--${network.status}`}
                  aria-hidden="true"
                />
                <div className="network-row__identity">
                  <strong>{network.displayName}</strong>
                  <span>{network.id}</span>
                </div>
                <dl>
                  <div>
                    <dt>管理模式</dt>
                    <dd>{getManagementModeLabel(network.managementMode)}</dd>
                  </div>
                  <div>
                    <dt>Fabric</dt>
                    <dd>{network.fabricVersion ?? '未标注'}</dd>
                  </div>
                  <div>
                    <dt>拓扑</dt>
                    <dd>
                      {network.organizationCount} 个组织 / {network.nodeCount} 个节点
                    </dd>
                  </div>
                  <div>
                    <dt>通道</dt>
                    <dd>{network.channelCount}</dd>
                  </div>
                </dl>
                <span className="network-row__runtime">
                  {getNetworkStatusLabel(network.status)}
                </span>
                <Link
                  className="network-row__open icon-button"
                  to={`/networks/${encodeURIComponent(network.id)}/topology`}
                  aria-label={`打开网络 ${network.displayName}`}
                  title="打开网络"
                >
                  <ArrowRight size={17} />
                </Link>
              </article>
            ))}
          </div>
        )}
      </Panel>

      {createOpen ? (
        <ManagedNetworkDialog
          returnFocusRef={createButtonRef}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            await queryClient.invalidateQueries({ queryKey: ['networks'] });
            setCreateOpen(false);
          }}
        />
      ) : null}

      {importOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeImportDialog}>
          <section
            ref={importDialogRef}
            className="import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-network-title"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={trapDialogFocus}
          >
            <div className="import-dialog__heading">
              <div>
                <span className="eyebrow">现有工作区</span>
                <h2 id="import-network-title">导入 Fabric 网络</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭导入对话框"
                disabled={importMutation.isPending}
                onClick={closeImportDialog}
              >
                <X size={18} />
              </button>
            </div>

            <form
              className="import-form"
              onSubmit={submitImport}
              aria-busy={importMutation.isPending}
            >
              <label>
                <span>网络 ID</span>
                <input
                  name="id"
                  required
                  pattern="[a-z][a-z0-9-]*[a-z0-9]"
                  minLength={3}
                  maxLength={64}
                  title="使用小写字母、数字和连字符，长度为 3 到 64 个字符"
                  aria-describedby="network-id-hint"
                  value={form.id}
                  onChange={(event) => setForm({ ...form, id: event.target.value })}
                />
                <small id="network-id-hint">使用小写字母、数字和连字符。</small>
              </label>
              <label>
                <span>显示名称</span>
                <input
                  name="displayName"
                  required
                  maxLength={100}
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                />
              </label>
              <label className="import-form__wide">
                <span>工作区根目录</span>
                <input
                  name="workspaceRoot"
                  required
                  aria-describedby="workspace-root-hint"
                  value={form.workspaceRoot}
                  onChange={(event) => setForm({ ...form, workspaceRoot: event.target.value })}
                />
                <small id="workspace-root-hint">
                  必须位于服务端管理员允许的网络根目录内。
                </small>
              </label>
              <label>
                <span>配置路径</span>
                <input
                  name="configPath"
                  required
                  aria-describedby="config-path-hint"
                  value={form.configPath}
                  onChange={(event) => setForm({ ...form, configPath: event.target.value })}
                />
                <small id="config-path-hint">相对于工作区根目录。</small>
              </label>
              <label>
                <span>Compose 项目名</span>
                <input
                  name="composeProject"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  title="使用小写字母、数字、下划线和连字符"
                  value={form.composeProject}
                  onChange={(event) => setForm({ ...form, composeProject: event.target.value })}
                />
              </label>
              <label>
                <span>Fabric 版本</span>
                <input
                  name="fabricVersion"
                  value={form.fabricVersion}
                  onChange={(event) => setForm({ ...form, fabricVersion: event.target.value })}
                />
              </label>
              <label>
                <span>Fabric CA 版本</span>
                <input
                  name="fabricCaVersion"
                  value={form.fabricCaVersion}
                  onChange={(event) => setForm({ ...form, fabricCaVersion: event.target.value })}
                />
              </label>

              {importMutation.isError ? (
                <div className="form-error" role="alert">
                  <ShieldAlert size={16} />
                  <span>
                    {getApiErrorMessage(importMutation.error, '无法导入该网络。')}
                  </span>
                </div>
              ) : null}

              <div className="import-form__actions">
                <button
                  className="secondary-action"
                  type="button"
                  disabled={importMutation.isPending}
                  onClick={closeImportDialog}
                >
                  取消
                </button>
                <button className="primary-action" type="submit" disabled={importMutation.isPending}>
                  {importMutation.isPending ? '正在校验…' : '导入网络'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function relativeConfigPath(workspaceRoot: string, configPath: string): string {
  const normalizedRoot = workspaceRoot.replace(/\/$/, '');
  const prefix = `${normalizedRoot}/`;
  return configPath.startsWith(prefix) ? configPath.slice(prefix.length) : 'config/orgs.yaml';
}

function normalizeNetworkId(value: string): string {
  let normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(normalized)) normalized = `network-${normalized}`;
  normalized = normalized.slice(0, 64).replace(/-+$/g, '');
  return normalized.length >= 3 ? normalized : `${normalized}-net`;
}
