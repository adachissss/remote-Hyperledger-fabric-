import { useEffect, useMemo, useState } from 'react';

import type {
  ChaincodeLanguage,
  ContractExecutionMode,
  Job,
  JobSummary,
} from '@plus-fabric/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  CheckCircle2,
  CircleAlert,
  Code2,
  FileCode2,
  PackageCheck,
  Play,
  RefreshCcw,
  Rocket,
  Send,
  ShieldCheck,
  SquareTerminal,
  X,
} from 'lucide-react';
import { Navigate, useParams } from 'react-router-dom';

import {
  cancelJob,
  createChaincodeDeployment,
  executeContract,
  getChaincodeInventory,
  getJob,
  getJobEvents,
  getJobs,
  getNetworks,
  subscribeToJobEvents,
} from '../../api/control-plane';
import { Panel } from '../../components/Panel';
import {
  formatDateTimeZh,
  getApiErrorMessage,
  getJobStatusLabel,
} from '../../i18n/zh-CN';
import { NetworkDetailHeader } from './NetworkDetailHeader';

type DeploymentForm = {
  channelName: string;
  name: string;
  version: string;
  sequence: string;
  language: ChaincodeLanguage;
  sourcePath: string;
  collectionsConfigPath: string;
  signaturePolicy: string;
};

type ExecutionForm = {
  mode: ContractExecutionMode;
  channelName: string;
  chaincodeName: string;
  organization: string;
  functionName: string;
  arguments: string;
  transient: string;
  targetOrganizations: string[];
};

const initialDeployment: DeploymentForm = {
  channelName: '',
  name: '',
  version: '',
  sequence: '1',
  language: 'node',
  sourcePath: '',
  collectionsConfigPath: '',
  signaturePolicy: '',
};

const initialExecution: ExecutionForm = {
  mode: 'evaluate',
  channelName: '',
  chaincodeName: '',
  organization: '',
  functionName: '',
  arguments: '[]',
  transient: '{}',
  targetOrganizations: [],
};

export function NetworkChaincodesPage() {
  const { networkId } = useParams();
  const queryClient = useQueryClient();
  const [deployment, setDeployment] = useState(initialDeployment);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [execution, setExecution] = useState(initialExecution);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 30_000,
  });
  const inventoryQuery = useQuery({
    queryKey: ['chaincode-inventory', networkId],
    queryFn: () => getChaincodeInventory(networkId!),
    enabled: Boolean(networkId),
    refetchInterval: 15_000,
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

  const deploymentMutation = useMutation({
    mutationFn: createChaincodeDeployment,
    onSuccess: async (job) => {
      setSelectedJobId(job.id);
      setDeploymentError(null);
      await queryClient.invalidateQueries({ queryKey: ['jobs', networkId] });
    },
  });
  const executionMutation = useMutation({ mutationFn: executeContract });
  const cancelMutation = useMutation({
    mutationFn: cancelJob,
    onSuccess: async (job) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs', networkId] }),
        queryClient.invalidateQueries({ queryKey: ['job', job.id] }),
      ]);
    },
  });

  const network = networksQuery.data?.items.find((item) => item.id === networkId);
  const allJobs = jobsQuery.data?.items ?? [];
  const deploymentJobs = useMemo(
    () => (jobsQuery.data?.items ?? []).filter(isChaincodeDeploymentJob),
    [jobsQuery.data?.items],
  );
  const activeJob = allJobs.find((job) => job.status === 'queued' || job.status === 'running');
  const definitionsForChannel = useMemo(
    () =>
      inventoryQuery.data?.committedDefinitions.filter(
        (definition) => definition.channelName === execution.channelName,
      ) ?? [],
    [execution.channelName, inventoryQuery.data],
  );

  useEffect(() => {
    const inventory = inventoryQuery.data;
    if (!inventory) return;
    setDeployment((current) => ({
      ...current,
      channelName: current.channelName || inventory.channels[0] || '',
    }));
    setExecution((current) => {
      const channelName = current.channelName || inventory.channels[0] || '';
      const definitions = inventory.committedDefinitions.filter(
        (definition) => definition.channelName === channelName,
      );
      return {
        ...current,
        channelName,
        chaincodeName: current.chaincodeName || definitions[0]?.name || '',
        organization: current.organization || inventory.organizations[0]?.name || '',
      };
    });
  }, [inventoryQuery.data]);

  useEffect(() => {
    if (selectedJobId && deploymentJobs.some((job) => job.id === selectedJobId)) return;
    setSelectedJobId(deploymentJobs[0]?.id ?? null);
  }, [deploymentJobs, selectedJobId]);

  useEffect(() => {
    if (!selectedJobId || isTerminal(jobQuery.data?.status)) return;
    return subscribeToJobEvents(selectedJobId, () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs', networkId] }),
        queryClient.invalidateQueries({ queryKey: ['job', selectedJobId] }),
        queryClient.invalidateQueries({ queryKey: ['job-events', selectedJobId] }),
      ]);
    });
  }, [jobQuery.data?.status, networkId, queryClient, selectedJobId]);

  if (!networkId) return <Navigate to="/networks" replace />;

  const refresh = () => {
    void Promise.all([
      inventoryQuery.refetch(),
      jobsQuery.refetch(),
      selectedJobId ? jobQuery.refetch() : Promise.resolve(),
      selectedJobId ? eventsQuery.refetch() : Promise.resolve(),
    ]);
  };

  const submitDeployment = () => {
    setDeploymentError(null);
    deploymentMutation.reset();
    const sequence = Number(deployment.sequence);
    if (!Number.isInteger(sequence) || sequence < 1) {
      setDeploymentError('序列必须是大于 0 的整数。');
      return;
    }
    if (
      !deployment.channelName ||
      !deployment.name.trim() ||
      !deployment.version.trim() ||
      !deployment.sourcePath.trim()
    ) {
      setDeploymentError('通道、链码名、版本和源码路径不能为空。');
      return;
    }
    deploymentMutation.mutate({
      networkId,
      deployment: {
        channelName: deployment.channelName,
        name: deployment.name.trim(),
        version: deployment.version.trim(),
        sequence,
        language: deployment.language,
        sourcePath: deployment.sourcePath.trim(),
        collectionsConfigPath: deployment.collectionsConfigPath.trim() || null,
        signaturePolicy: deployment.signaturePolicy.trim() || null,
      },
    });
  };

  const submitExecution = () => {
    setExecutionError(null);
    executionMutation.reset();
    try {
      const args = JSON.parse(execution.arguments) as unknown;
      const transient = JSON.parse(execution.transient) as unknown;
      if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) {
        throw new Error('参数必须是字符串 JSON 数组。');
      }
      if (
        !transient ||
        typeof transient !== 'object' ||
        Array.isArray(transient) ||
        !Object.values(transient).every((value) => typeof value === 'string')
      ) {
        throw new Error('Transient 必须是字符串键值组成的 JSON 对象。');
      }
      if (
        !execution.channelName ||
        !execution.chaincodeName ||
        !execution.organization ||
        !execution.functionName.trim()
      ) {
        throw new Error('通道、链码、执行组织和函数名不能为空。');
      }
      executionMutation.mutate({
        networkId,
        mode: execution.mode,
        execution: {
          channelName: execution.channelName,
          chaincodeName: execution.chaincodeName,
          organization: execution.organization,
          functionName: execution.functionName.trim(),
          arguments: args,
          targetOrganizations: execution.targetOrganizations,
          transient: transient as Record<string, string>,
        },
      });
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : '执行参数格式不正确。');
    }
  };

  return (
    <div className="page-stack page-enter chaincode-page">
      <NetworkDetailHeader
        networkId={networkId}
        displayName={network?.displayName ?? networkId}
        eyebrow="通用链码控制"
        title="链码生命周期与执行"
        description="查看任意已提交定义，从网络工作区部署链码，并使用指定组织执行 evaluate 或 submit。"
        refreshing={
          inventoryQuery.isFetching || jobsQuery.isFetching || jobQuery.isFetching || eventsQuery.isFetching
        }
        onRefresh={refresh}
      />

      {inventoryQuery.isPending ? (
        <ChaincodeState busy title="正在读取链码清单" description="正在查询各组织已安装包和通道已提交定义。" />
      ) : inventoryQuery.isError ? (
        <ChaincodeState
          error
          title="链码清单不可用"
          description={getApiErrorMessage(inventoryQuery.error, '无法从 Fabric Peer 查询链码。')}
          action={<button className="secondary-action" type="button" onClick={refresh}>重试</button>}
        />
      ) : (
        <>
          <section className="chaincode-summary" aria-label="链码摘要">
            <ChaincodeMetric icon={Code2} label="已提交定义" value={inventoryQuery.data.committedDefinitions.length} />
            <ChaincodeMetric icon={PackageCheck} label="已安装包记录" value={inventoryQuery.data.installedPackages.length} />
            <ChaincodeMetric icon={Boxes} label="可用通道" value={inventoryQuery.data.channels.length} />
            <ChaincodeMetric icon={ShieldCheck} label="执行组织" value={inventoryQuery.data.organizations.length} />
          </section>

          {activeJob ? (
            <div className="active-job-strip chaincode-active-job">
              <span className="active-job-strip__pulse" aria-hidden="true" />
              <div>
                <strong>
                  {activeJob.kind === 'chaincode-deployment' ? '链码部署' : '网络运维'}正在
                  {activeJob.status === 'queued' ? '等待' : '执行'}
                </strong>
                <small>{activeJob.context.name ? `${activeJob.context.name} · ` : ''}{activeJob.id}</small>
              </div>
              <button
                className="secondary-action"
                type="button"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate(activeJob.id)}
              >
                <X size={14} />取消作业
              </button>
            </div>
          ) : null}

          <div className="chaincode-inventory-grid">
            <Panel eyebrow="通道定义" title="已提交链码" className="chaincode-definitions-panel">
              {inventoryQuery.data.committedDefinitions.length === 0 ? (
                <div className="chaincode-empty"><Code2 size={24} /><strong>尚无已提交定义</strong><span>可以使用下方部署表单提交第一个链码。</span></div>
              ) : (
                <div className="chaincode-definition-list">
                  {inventoryQuery.data.committedDefinitions.map((definition) => (
                    <article className="chaincode-definition" key={`${definition.channelName}-${definition.name}-${definition.sequence}`}>
                      <span className="chaincode-definition__mark"><FileCode2 size={17} /></span>
                      <div>
                        <strong>{definition.name}</strong>
                        <small>{definition.channelName} · 观察节点 {definition.observedPeer}</small>
                      </div>
                      <dl>
                        <div><dt>版本</dt><dd>{definition.version}</dd></div>
                        <div><dt>序列</dt><dd>{definition.sequence}</dd></div>
                        <div><dt>背书插件</dt><dd>{definition.endorsementPlugin ?? '默认'}</dd></div>
                      </dl>
                    </article>
                  ))}
                </div>
              )}
            </Panel>

            <Panel eyebrow="组织安装状态" title="已安装包" className="chaincode-packages-panel">
              {inventoryQuery.data.installedPackages.length === 0 ? (
                <div className="chaincode-empty chaincode-empty--compact"><PackageCheck size={22} /><span>没有查询到已安装包。</span></div>
              ) : (
                <div className="chaincode-package-list">
                  {inventoryQuery.data.installedPackages.map((item) => (
                    <article key={`${item.mspId}-${item.packageId}`}>
                      <PackageCheck size={15} />
                      <div><strong>{item.label}</strong><small>{item.organization} · {item.mspId}</small></div>
                      <code>{item.packageId}</code>
                    </article>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div className="chaincode-control-grid">
            <Panel eyebrow="Fabric v2 生命周期" title="部署 / 升级链码" className="chaincode-form-panel">
              <div className="chaincode-form-intro"><Rocket size={17} /><span>源码路径相对于当前网络工作区；平台不会预置或猜测链码。</span></div>
              <div className="chaincode-form">
                <FormSelect label="目标通道" value={deployment.channelName} onChange={(value) => setDeployment((current) => ({ ...current, channelName: value }))} options={inventoryQuery.data.channels} />
                <FormField label="链码名称" value={deployment.name} onChange={(value) => setDeployment((current) => ({ ...current, name: value }))} />
                <FormField label="版本" value={deployment.version} onChange={(value) => setDeployment((current) => ({ ...current, version: value }))} />
                <FormField label="序列" type="number" value={deployment.sequence} onChange={(value) => setDeployment((current) => ({ ...current, sequence: value }))} />
                <FormSelect label="链码语言" value={deployment.language} onChange={(value) => setDeployment((current) => ({ ...current, language: value as ChaincodeLanguage }))} options={['node', 'golang', 'java']} />
                <FormField label="源码相对路径" value={deployment.sourcePath} onChange={(value) => setDeployment((current) => ({ ...current, sourcePath: value }))} wide />
                <FormField label="Collections 配置路径（可选）" value={deployment.collectionsConfigPath} onChange={(value) => setDeployment((current) => ({ ...current, collectionsConfigPath: value }))} wide />
                <FormField label="签名策略（可选）" value={deployment.signaturePolicy} onChange={(value) => setDeployment((current) => ({ ...current, signaturePolicy: value }))} wide />
              </div>
              {deploymentError || deploymentMutation.isError ? (
                <FormNotice message={deploymentError ?? getApiErrorMessage(deploymentMutation.error, '无法创建链码部署作业。')} />
              ) : null}
              <button className="primary-action chaincode-submit" type="button" disabled={Boolean(activeJob) || deploymentMutation.isPending} onClick={submitDeployment}>
                <Rocket size={15} />创建部署作业
              </button>
            </Panel>

            <Panel eyebrow="合约调用" title="执行控制台" className="chaincode-form-panel">
              <div className="execution-mode" role="group" aria-label="执行模式">
                <button type="button" aria-pressed={execution.mode === 'evaluate'} className={execution.mode === 'evaluate' ? 'is-selected' : undefined} onClick={() => setExecution((current) => ({ ...current, mode: 'evaluate' }))}><Play size={14} />查询</button>
                <button type="button" aria-pressed={execution.mode === 'submit'} className={execution.mode === 'submit' ? 'is-selected' : undefined} onClick={() => setExecution((current) => ({ ...current, mode: 'submit' }))}><Send size={14} />提交交易</button>
              </div>
              <div className="chaincode-form">
                <FormSelect label="通道" value={execution.channelName} onChange={(value) => {
                  const first = inventoryQuery.data.committedDefinitions.find((item) => item.channelName === value);
                  setExecution((current) => ({ ...current, channelName: value, chaincodeName: first?.name ?? '' }));
                }} options={inventoryQuery.data.channels} />
                <FormSelect label="链码" value={execution.chaincodeName} onChange={(value) => setExecution((current) => ({ ...current, chaincodeName: value }))} options={definitionsForChannel.map((item) => item.name)} />
                <FormSelect label="执行组织" value={execution.organization} onChange={(value) => setExecution((current) => ({ ...current, organization: value }))} options={inventoryQuery.data.organizations.map((item) => item.name)} />
                <FormField label="函数名" value={execution.functionName} onChange={(value) => setExecution((current) => ({ ...current, functionName: value }))} />
                <FormTextArea label="参数 JSON 字符串数组" value={execution.arguments} onChange={(value) => setExecution((current) => ({ ...current, arguments: value }))} />
                <FormTextArea label="Transient JSON 字符串对象" value={execution.transient} onChange={(value) => setExecution((current) => ({ ...current, transient: value }))} />
              </div>
              {execution.mode === 'submit' ? (
                <div className="endorsement-targets">
                  <span>背书目标（不选择则使用全部组织）</span>
                  <div>
                    {inventoryQuery.data.organizations.map((organization) => (
                      <label key={organization.mspId}>
                        <input
                          type="checkbox"
                          checked={execution.targetOrganizations.includes(organization.name)}
                          onChange={(event) => setExecution((current) => ({
                            ...current,
                            targetOrganizations: event.target.checked
                              ? [...current.targetOrganizations, organization.name]
                              : current.targetOrganizations.filter((item) => item !== organization.name),
                          }))}
                        />
                        <span>{organization.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
              {executionError || executionMutation.isError ? (
                <FormNotice message={executionError ?? getApiErrorMessage(executionMutation.error, '合约执行失败。')} />
              ) : null}
              <button className="primary-action chaincode-submit" type="button" disabled={executionMutation.isPending} onClick={submitExecution}>
                {execution.mode === 'evaluate' ? <Play size={15} /> : <Send size={15} />}
                {executionMutation.isPending ? '正在执行' : execution.mode === 'evaluate' ? '执行查询' : '提交交易'}
              </button>

              {executionMutation.data ? <ExecutionResult result={executionMutation.data} /> : null}
            </Panel>
          </div>

          <Panel
            eyebrow="实时部署记录"
            title={`${deploymentJobs.length} 个链码作业`}
            action={<button className="icon-button" type="button" onClick={() => jobsQuery.refetch()} title="刷新作业"><RefreshCcw size={15} className={jobsQuery.isFetching ? 'icon-spin' : undefined} /></button>}
          >
            {deploymentJobs.length === 0 ? (
              <div className="chaincode-empty"><SquareTerminal size={25} /><strong>尚未创建部署作业</strong><span>部署日志、最终状态与退出码会显示在这里。</span></div>
            ) : (
              <div className="operations-workbench chaincode-job-workbench">
                <div className="job-list">
                  {deploymentJobs.map((job) => (
                    <button type="button" key={job.id} className={selectedJobId === job.id ? 'is-selected' : undefined} onClick={() => setSelectedJobId(job.id)}>
                      <span className={`job-status-dot job-status-dot--${job.status}`} aria-hidden="true" />
                      <span><strong>{job.context.name ?? '链码部署'}</strong><small>{job.context.channelName ?? job.networkId} · {formatDateTimeZh(job.createdAt)}</small></span>
                      <em className={`job-status job-status--${job.status}`}>{getJobStatusLabel(job.status)}</em>
                    </button>
                  ))}
                </div>
                <DeploymentJobConsole job={jobQuery.data ?? null} events={eventsQuery.data?.items ?? []} pending={jobQuery.isPending || eventsQuery.isPending} />
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function ChaincodeMetric({ icon: Icon, label, value }: { icon: typeof Code2; label: string; value: number }) {
  return <div className="chaincode-metric"><Icon size={17} /><span>{label}</span><strong>{value}</strong></div>;
}

function FormField({ label, value, onChange, type = 'text', wide = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; wide?: boolean }) {
  return <label className={wide ? 'is-wide' : undefined}><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function FormSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option>{[...new Set(options)].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function FormTextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span>{label}</span><textarea value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} /></label>;
}

function FormNotice({ message }: { message: string }) {
  return <div className="form-error chaincode-form-error"><CircleAlert size={15} />{message}</div>;
}

function ExecutionResult({ result }: { result: Awaited<ReturnType<typeof executeContract>> }) {
  const display = result.output.json !== null
    ? JSON.stringify(result.output.json, null, 2)
    : result.output.text ?? result.output.base64;
  return (
    <section className="contract-result">
      <header><CheckCircle2 size={17} /><div><strong>{result.mode === 'evaluate' ? '查询完成' : '交易已提交'}</strong><span>{result.durationMs} ms · 响应 {result.responseStatus ?? '—'}</span></div></header>
      {result.transactionId ? <div className="contract-result__tx"><span>交易 ID</span><code>{result.transactionId}</code></div> : null}
      <pre>{display}</pre>
      <details><summary>查看 base64 原值</summary><code>{result.output.base64}</code></details>
    </section>
  );
}

function DeploymentJobConsole({ job, events, pending }: { job: Job | null; events: Array<{ id: number; stream: string | null; message: string; createdAt: string }>; pending: boolean }) {
  if (pending) return <div className="job-console job-console--loading">正在读取部署日志…</div>;
  if (!job) return <div className="job-console job-console--loading">请选择一个链码作业。</div>;
  return (
    <div className="job-console">
      <header><div><span>{job.context.name ?? '链码部署'} · {job.context.version ?? '—'}</span><strong className={`job-status job-status--${job.status}`}>{getJobStatusLabel(job.status)}</strong></div><dl><div><dt>通道</dt><dd>{job.context.channelName ?? '—'}</dd></div><div><dt>序列</dt><dd>{job.context.sequence ?? '—'}</dd></div><div><dt>完成</dt><dd>{formatDateTimeZh(job.finishedAt)}</dd></div><div><dt>退出码</dt><dd>{job.exitCode ?? '—'}</dd></div></dl></header>
      {job.errorMessage ? <div className="job-console__error">{job.errorMessage}</div> : null}
      <div className="job-log" aria-label="链码部署实时日志" aria-live="polite" aria-relevant="additions">
        {events.length === 0 ? <span className="job-log__empty">等待日志输出…</span> : events.map((event) => <div className={`job-log__line job-log__line--${event.stream ?? 'system'}`} key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{event.stream ?? 'system'}</span><code>{event.message}</code></div>)}
      </div>
    </div>
  );
}

function ChaincodeState({ title, description, busy = false, error = false, action }: { title: string; description: string; busy?: boolean; error?: boolean; action?: React.ReactNode }) {
  return <div className={`query-state chaincode-state${error ? ' query-state--error' : ''}`} role={error ? 'alert' : 'status'}>{busy ? <span className="query-state__spinner" /> : null}<div><h3>{title}</h3><p>{description}</p></div>{action}</div>;
}

function isChaincodeDeploymentJob(job: JobSummary): boolean {
  return job.kind === 'chaincode-deployment';
}

function isTerminal(status: Job['status'] | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
