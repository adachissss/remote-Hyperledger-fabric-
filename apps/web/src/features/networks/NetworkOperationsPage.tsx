import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type {
  JobStatus,
  JobSummary,
  NetworkLifecycleAction,
  NetworkScriptAction,
} from '@plus-fabric/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  Play,
  RefreshCcw,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import {
  cancelJob,
  createNetworkAction,
  deleteNetwork,
  getJob,
  getJobEvents,
  getJobs,
  getNetworks,
  getNetworkTopology,
  subscribeToJobEvents,
} from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import {
  formatDateTimeZh,
  getApiErrorMessage,
  getJobStatusLabel,
  getJobActionLabel,
  getNetworkActionLabel,
} from '../../i18n/zh-CN';
import { NetworkDetailHeader } from './NetworkDetailHeader';

const actions: Array<{
  action: NetworkScriptAction;
  title: string;
  description: string;
  icon: typeof Play;
  tone: 'primary' | 'neutral' | 'warning' | 'danger';
}> = [
  {
    action: 'up',
    title: '部署 / 初始化',
    description: '执行完整的 CA、证书、节点、通道生成与启动流程。',
    icon: Play,
    tone: 'primary',
  },
  {
    action: 'stop',
    title: '停止网络',
    description: '停止 Peer、Orderer 与 CA 容器，保留卷和网络材料。',
    icon: Square,
    tone: 'neutral',
  },
  {
    action: 'restart',
    title: '恢复网络',
    description: '启动已有容器并重新写入当前网络的主机映射。',
    icon: RotateCcw,
    tone: 'warning',
  },
  {
    action: 'down',
    title: '清理网络',
    description: '删除容器卷、组织材料与通道产物，适合重新初始化实验环境。',
    icon: Trash2,
    tone: 'danger',
  },
];

export function NetworkOperationsPage() {
  const { networkId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<'down' | 'delete' | null>(null);
  const [confirmationValue, setConfirmationValue] = useState('');
  const downButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDialogRef = useRef<HTMLElement>(null);
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 30_000,
  });
  const topologyQuery = useQuery({
    queryKey: ['network-topology', networkId],
    queryFn: () => getNetworkTopology(networkId!),
    enabled: Boolean(networkId),
    staleTime: 30_000,
  });
  const jobsQuery = useQuery({
    queryKey: ['jobs', networkId],
    queryFn: () => getJobs(networkId!),
    enabled: Boolean(networkId),
    refetchInterval: 3_000,
  });
  const jobQuery = useQuery({
    queryKey: ['job', selectedJobId],
    queryFn: () => getJob(selectedJobId!),
    enabled: Boolean(selectedJobId),
    refetchInterval: 3_000,
  });
  const eventsQuery = useQuery({
    queryKey: ['job-events', selectedJobId],
    queryFn: () => getJobEvents(selectedJobId!),
    enabled: Boolean(selectedJobId),
    refetchInterval: 3_000,
  });
  const actionMutation = useMutation({
    mutationFn: createNetworkAction,
    onSuccess: async (job) => {
      setSelectedJobId(job.id);
      setConfirmationAction(null);
      await queryClient.invalidateQueries({ queryKey: ['jobs', networkId] });
    },
  });
  const deletionMutation = useMutation({
    mutationFn: deleteNetwork,
    onSuccess: async (job) => {
      setSelectedJobId(job.id);
      setConfirmationAction(null);
      await queryClient.invalidateQueries({ queryKey: ['jobs', networkId] });
    },
  });
  const cancelMutation = useMutation({
    mutationFn: cancelJob,
    onSuccess: async (job) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs', networkId] }),
        queryClient.invalidateQueries({ queryKey: ['job', job.id] }),
      ]);
    },
  });

  const allJobs = jobsQuery.data?.items ?? [];
  const jobs = allJobs.filter(isNetworkLifecycleJob);
  const activeJob = allJobs.find((job) => job.status === 'queued' || job.status === 'running');

  useEffect(() => {
    if (selectedJobId && jobs.some((job) => job.id === selectedJobId)) return;
    setSelectedJobId(jobs[0]?.id ?? null);
  }, [jobs, selectedJobId]);

  useEffect(() => {
    if (!selectedJobId) return;
    if (
      jobQuery.data?.status === 'succeeded' ||
      jobQuery.data?.status === 'failed' ||
      jobQuery.data?.status === 'cancelled'
    ) {
      return;
    }
    return subscribeToJobEvents(selectedJobId, () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs', networkId] }),
        queryClient.invalidateQueries({ queryKey: ['job', selectedJobId] }),
        queryClient.invalidateQueries({ queryKey: ['job-events', selectedJobId] }),
      ]);
    });
  }, [jobQuery.data?.status, networkId, queryClient, selectedJobId]);

  useEffect(() => {
    if (confirmationAction === null) return;
    const returnFocus = confirmationAction === 'delete' ? deleteButtonRef : downButtonRef;
    confirmDialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => returnFocus.current?.focus();
  }, [confirmationAction]);

  useEffect(() => {
    if (jobQuery.data?.action !== 'delete' || jobQuery.data.status !== 'succeeded') return;
    void queryClient.invalidateQueries({ queryKey: ['networks'] }).then(() => {
      navigate('/networks', { replace: true });
    });
  }, [jobQuery.data?.action, jobQuery.data?.status, navigate, queryClient]);

  if (!networkId) return <Navigate to="/networks" replace />;

  const networkSummary = networksQuery.data?.items.find((network) => network.id === networkId);
  const startAction = (action: NetworkScriptAction, confirmation?: string) => {
    actionMutation.reset();
    actionMutation.mutate({
      networkId,
      action,
      ...(confirmation === undefined ? {} : { confirmation }),
    });
  };
  const refresh = () => {
    void Promise.all([
      networksQuery.refetch(),
      topologyQuery.refetch(),
      jobsQuery.refetch(),
      selectedJobId ? jobQuery.refetch() : Promise.resolve(),
      selectedJobId ? eventsQuery.refetch() : Promise.resolve(),
    ]);
  };
  const handleConfirmDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setConfirmationAction(null);
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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

  return (
    <div className="page-stack page-enter">
      <NetworkDetailHeader
        networkId={networkId}
        displayName={topologyQuery.data?.networkName ?? networkId}
        eyebrow="脚本作业控制"
        title="网络运维"
        description="从网页执行原有 network.sh，命令行启动方式保持不变。"
        refreshing={
          networksQuery.isFetching ||
          topologyQuery.isFetching ||
          jobsQuery.isFetching ||
          jobQuery.isFetching ||
          eventsQuery.isFetching
        }
        onRefresh={refresh}
      />

      <div className="runtime-notice operations-notice" role="status">
        <TerminalSquare size={17} />
        <span>
          所有操作都在已注册工作区中调用原脚本。当前网络同一时间只执行一个作业，其他网络可独立运行。
        </span>
      </div>

      <section className="operation-action-grid" aria-label="网络生命周期操作">
        {actions.map(({ action, title, description, icon: Icon, tone }) => (
          <button
            ref={action === 'down' ? downButtonRef : undefined}
            className={`operation-action operation-action--${tone}`}
            type="button"
            key={action}
            disabled={Boolean(activeJob) || actionMutation.isPending || deletionMutation.isPending}
            onClick={() => {
              if (action === 'down') {
                actionMutation.reset();
                setConfirmationValue('');
                setConfirmationAction('down');
              } else {
                startAction(action);
              }
            }}
          >
            <span className="operation-action__icon"><Icon size={19} /></span>
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </button>
        ))}
      </section>

      <section className="network-delete-zone" aria-labelledby="network-delete-title">
        <div className="network-delete-zone__signal" aria-hidden="true"><Trash2 size={18} /></div>
        <div>
          <span className="eyebrow">注册与资源回收</span>
          <h2 id="network-delete-title">彻底删除网络</h2>
          <p>
            先执行完整清理，再释放端口和网络注册。
            {networkSummary?.managementMode === 'imported'
              ? ' 外部导入工作区会保留。'
              : ' 平台托管工作区也会一并删除。'}
          </p>
        </div>
        <button
          ref={deleteButtonRef}
          className="danger-action network-delete-zone__action"
          type="button"
          disabled={Boolean(activeJob) || actionMutation.isPending || deletionMutation.isPending}
          onClick={() => {
            deletionMutation.reset();
            setConfirmationValue('');
            setConfirmationAction('delete');
          }}
        >
          <Trash2 size={15} /> 删除网络
        </button>
      </section>

      {activeJob ? (
        <div className="active-job-strip">
          <span className="active-job-strip__pulse" aria-hidden="true" />
          <div>
            <strong>{getJobActionLabel(activeJob.kind, activeJob.action)}正在{activeJob.status === 'queued' ? '等待' : '执行'}</strong>
            <small>{activeJob.id}</small>
          </div>
          <button
            className="secondary-action"
            type="button"
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate(activeJob.id)}
          >
            <X size={14} /> 取消作业
          </button>
        </div>
      ) : null}

      {actionMutation.isError ? (
        <div className="runtime-notice runtime-notice--warning" role="alert">
          <CircleAlert size={17} />
          {getApiErrorMessage(actionMutation.error, '无法创建网络运维作业。')}
        </div>
      ) : null}

      {deletionMutation.isError ? (
        <div className="runtime-notice runtime-notice--warning" role="alert">
          <CircleAlert size={17} />
          {getApiErrorMessage(deletionMutation.error, '无法创建网络删除作业。')}
        </div>
      ) : null}

      {cancelMutation.isError ? (
        <div className="runtime-notice runtime-notice--warning" role="alert">
          <CircleAlert size={17} />
          {getApiErrorMessage(cancelMutation.error, '无法取消当前运维作业。')}
        </div>
      ) : null}

      <Panel
        eyebrow="作业历史"
        title={jobsQuery.isPending ? '正在加载运维记录' : `${jobs.length} 个作业`}
        action={
          <button className="icon-button" type="button" onClick={() => jobsQuery.refetch()} title="刷新作业">
            <RefreshCcw size={15} className={jobsQuery.isFetching ? 'icon-spin' : undefined} />
          </button>
        }
      >
        {jobsQuery.isError ? (
          <div className="channel-empty">{getApiErrorMessage(jobsQuery.error, '无法加载作业历史。')}</div>
        ) : jobs.length === 0 ? (
          <div className="operations-empty">
            <TerminalSquare size={28} />
            <strong>尚未执行网络操作</strong>
            <p>上方操作会调用当前工作区原有的 network.sh，并在这里保留步骤与日志。</p>
          </div>
        ) : (
          <div className="operations-workbench">
            <div className="job-list">
              {jobs.map((job) => (
                <button
                  type="button"
                  key={job.id}
                  className={selectedJobId === job.id ? 'is-selected' : undefined}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <span className={`job-status-dot job-status-dot--${job.status}`} aria-hidden="true" />
                  <span>
                    <strong>{getNetworkActionLabel(job.action)}</strong>
                    <small>{formatDateTimeZh(job.createdAt)}</small>
                  </span>
                  <em className={`job-status job-status--${job.status}`}>
                    {getJobStatusLabel(job.status)}
                  </em>
                </button>
              ))}
            </div>

            <JobConsole
              status={jobQuery.data?.status ?? null}
              action={
                jobQuery.data?.kind === 'network-lifecycle' &&
                isNetworkLifecycleAction(jobQuery.data.action)
                  ? jobQuery.data.action
                  : null
              }
              createdAt={jobQuery.data?.createdAt ?? null}
              startedAt={jobQuery.data?.startedAt ?? null}
              finishedAt={jobQuery.data?.finishedAt ?? null}
              exitCode={jobQuery.data?.exitCode ?? null}
              errorMessage={jobQuery.data?.errorMessage ?? null}
              events={eventsQuery.data?.items ?? []}
              pending={jobQuery.isPending || eventsQuery.isPending}
              error={
                jobQuery.isError
                  ? getApiErrorMessage(jobQuery.error, '无法读取作业详情。')
                  : eventsQuery.isError
                    ? getApiErrorMessage(eventsQuery.error, '无法读取作业日志。')
                    : null
              }
            />
          </div>
        )}
      </Panel>

      {confirmationAction !== null ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmationAction(null)}>
          <section
            ref={confirmDialogRef}
            className="import-dialog operation-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="network-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={handleConfirmDialogKeyDown}
          >
            <div className="import-dialog__heading">
              <div>
                <span className="eyebrow">破坏性操作</span>
                <h2 id="network-confirm-title">
                  {confirmationAction === 'delete' ? '确认彻底删除网络' : '确认清理网络'}
                </h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setConfirmationAction(null)} aria-label="关闭">
                <X size={17} />
              </button>
            </div>
            <p>
              {confirmationAction === 'delete' ? (
                <>
                  系统会先执行 <code>network.sh down</code>，删除目标容器、卷、Docker Network、链码构建资源和运行材料，然后释放注册记录与端口。
                  {networkSummary?.managementMode === 'imported'
                    ? ' 导入网络的外部工作区不会删除。'
                    : ' 平台托管工作区会永久删除。'}
                </>
              ) : (
                <>此操作执行 <code>network.sh down</code>，会删除运行容器、卷、组织材料和通道产物，但保留网络注册与工作区。</>
              )}{' '}
              请输入网络 ID <strong>{networkId}</strong> 继续。
            </p>
            <input
              autoFocus
              value={confirmationValue}
              onChange={(event) => setConfirmationValue(event.target.value)}
              placeholder={networkId}
            />
            <div className="operation-confirm-dialog__actions">
              <button className="secondary-action" type="button" onClick={() => setConfirmationAction(null)}>取消</button>
              <button
                className="danger-action"
                type="button"
                disabled={
                  confirmationValue !== networkId ||
                  actionMutation.isPending ||
                  deletionMutation.isPending
                }
                onClick={() => {
                  if (confirmationAction === 'delete') {
                    deletionMutation.mutate({ networkId, confirmation: confirmationValue });
                  } else {
                    startAction('down', confirmationValue);
                  }
                }}
              >
                <Trash2 size={15} />
                {confirmationAction === 'delete' ? '永久删除' : '清理网络'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function isNetworkLifecycleAction(value: string): value is NetworkLifecycleAction {
  return (
    value === 'up' ||
    value === 'stop' ||
    value === 'restart' ||
    value === 'down' ||
    value === 'delete'
  );
}

function isNetworkLifecycleJob(
  job: JobSummary,
): job is JobSummary & { kind: 'network-lifecycle'; action: NetworkLifecycleAction } {
  return job.kind === 'network-lifecycle' && isNetworkLifecycleAction(job.action);
}

function JobConsole({
  status,
  action,
  createdAt,
  startedAt,
  finishedAt,
  exitCode,
  errorMessage,
  events,
  pending,
  error,
}: {
  status: JobStatus | null;
  action: NetworkLifecycleAction | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  events: Array<{ id: number; stream: string | null; message: string; createdAt: string }>;
  pending: boolean;
  error: string | null;
}) {
  if (pending) {
    return <div className="job-console job-console--loading">正在读取作业详情…</div>;
  }
  if (error) {
    return <div className="job-console job-console--error">{error}</div>;
  }
  if (!status || !action) {
    return <div className="job-console job-console--loading">请选择一个作业。</div>;
  }

  return (
    <div className="job-console">
      <header>
        <div>
          <span>{getNetworkActionLabel(action)}</span>
          <strong className={`job-status job-status--${status}`}>{getJobStatusLabel(status)}</strong>
        </div>
        <dl>
          <div><dt>创建</dt><dd>{formatDateTimeZh(createdAt)}</dd></div>
          <div><dt>开始</dt><dd>{formatDateTimeZh(startedAt)}</dd></div>
          <div><dt>完成</dt><dd>{formatDateTimeZh(finishedAt)}</dd></div>
          <div><dt>退出码</dt><dd>{exitCode ?? '—'}</dd></div>
        </dl>
      </header>
      {errorMessage ? <div className="job-console__error">{errorMessage}</div> : null}
      <div className="job-log" aria-label="作业实时日志">
        {events.length === 0 ? (
          <span className="job-log__empty">等待日志输出…</span>
        ) : (
          events.map((event) => (
            <div className={`job-log__line job-log__line--${event.stream ?? 'system'}`} key={event.id}>
              <time>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
              <span>{event.stream ?? 'system'}</span>
              <code>{event.message || ' '}</code>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
