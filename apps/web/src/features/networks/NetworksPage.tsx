import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Boxes, Plus, ShieldAlert, X } from 'lucide-react';

import { ControlPlaneApiError, getNetworks, importNetwork } from '../../api/control-plane';
import { Panel } from '../../components/Panel';

export function NetworksPage() {
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
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

  const closeImportDialog = () => setImportOpen(false);

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
          <span className="eyebrow">Network registry</span>
          <h1>Independent networks, one inventory.</h1>
          <p>
            Every network owns its workspace, runtime namespace, credentials, versions, and
            operation history.
          </p>
        </div>
        <div className="page-heading__actions">
          <button
            ref={importButtonRef}
            className="secondary-action"
            type="button"
            onClick={() => {
              importMutation.reset();
              setImportOpen(true);
            }}
          >
            <ArrowDownToLine size={16} /> Import network
          </button>
          <button className="primary-action" type="button" disabled title="Available in Phase 1">
            <Plus size={16} /> Create network
          </button>
        </div>
      </section>

      <div className="registry-notice">
        <ShieldAlert size={18} />
        <span>
          Imports are accepted only from workspace roots allowed by the API administrator. No
          network is inferred from the repository or host environment.
        </span>
      </div>

      <Panel
        eyebrow="Inventory"
        title={
          networksQuery.isPending
            ? 'Loading registered networks'
            : networksQuery.isError
              ? 'Network registry unavailable'
              : `${total ?? 0} registered network${total === 1 ? '' : 's'}`
        }
      >
        {networksQuery.isPending ? (
          <div className="network-table-empty" role="status" aria-live="polite">
            <span className="query-state__spinner" aria-hidden="true" />
            <h3>Loading network definitions</h3>
          </div>
        ) : networksQuery.isError ? (
          <div className="network-table-empty network-table-empty--error">
            <ShieldAlert size={30} strokeWidth={1.35} />
            <h3>The registry request failed</h3>
            <p>
              {networksQuery.error instanceof ControlPlaneApiError
                ? networksQuery.error.message
                : 'The control plane API could not be reached.'}
            </p>
            <button className="secondary-action" type="button" onClick={() => networksQuery.refetch()}>
              Retry request
            </button>
          </div>
        ) : networks.length === 0 ? (
          <div className="network-table-empty">
            <Boxes size={30} strokeWidth={1.35} />
            <h3>No network definitions</h3>
            <p>Import an existing workspace to add the first network.</p>
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
                    <dt>Mode</dt>
                    <dd>{network.managementMode}</dd>
                  </div>
                  <div>
                    <dt>Fabric</dt>
                    <dd>{network.fabricVersion ?? 'unknown'}</dd>
                  </div>
                  <div>
                    <dt>Topology</dt>
                    <dd>
                      {network.organizationCount} org / {network.nodeCount} nodes
                    </dd>
                  </div>
                  <div>
                    <dt>Channels</dt>
                    <dd>{network.channelCount}</dd>
                  </div>
                </dl>
                <span className="network-row__runtime">{network.status}</span>
              </article>
            ))}
          </div>
        )}
      </Panel>

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
                <span className="eyebrow">Existing workspace</span>
                <h2 id="import-network-title">Import Fabric network</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close import dialog"
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
                <span>Network ID</span>
                <input
                  name="id"
                  required
                  pattern="[a-z][a-z0-9-]*[a-z0-9]"
                  minLength={3}
                  maxLength={64}
                  aria-describedby="network-id-hint"
                  value={form.id}
                  onChange={(event) => setForm({ ...form, id: event.target.value })}
                />
                <small id="network-id-hint">Lowercase letters, numbers, and hyphens.</small>
              </label>
              <label>
                <span>Display name</span>
                <input
                  name="displayName"
                  required
                  maxLength={100}
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                />
              </label>
              <label className="import-form__wide">
                <span>Workspace root</span>
                <input
                  name="workspaceRoot"
                  required
                  aria-describedby="workspace-root-hint"
                  value={form.workspaceRoot}
                  onChange={(event) => setForm({ ...form, workspaceRoot: event.target.value })}
                />
                <small id="workspace-root-hint">
                  Must be inside a server-side allowed network root.
                </small>
              </label>
              <label>
                <span>Config path</span>
                <input
                  name="configPath"
                  required
                  aria-describedby="config-path-hint"
                  value={form.configPath}
                  onChange={(event) => setForm({ ...form, configPath: event.target.value })}
                />
                <small id="config-path-hint">Relative to the workspace root.</small>
              </label>
              <label>
                <span>Compose project</span>
                <input
                  name="composeProject"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  value={form.composeProject}
                  onChange={(event) => setForm({ ...form, composeProject: event.target.value })}
                />
              </label>
              <label>
                <span>Fabric version</span>
                <input
                  name="fabricVersion"
                  value={form.fabricVersion}
                  onChange={(event) => setForm({ ...form, fabricVersion: event.target.value })}
                />
              </label>
              <label>
                <span>Fabric CA version</span>
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
                    {importMutation.error instanceof ControlPlaneApiError
                      ? importMutation.error.message
                      : 'The network could not be imported.'}
                  </span>
                </div>
              ) : null}

              <div className="import-form__actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={closeImportDialog}
                >
                  Cancel
                </button>
                <button className="primary-action" type="submit" disabled={importMutation.isPending}>
                  {importMutation.isPending ? 'Validating…' : 'Import network'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
