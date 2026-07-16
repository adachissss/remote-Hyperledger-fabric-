import { useQuery } from '@tanstack/react-query';
import { Activity, Boxes, RadioTower, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';

import { getNetworks, getSystemHealth } from '../../api/control-plane';
import { MetricCard } from '../../components/MetricCard';
import { Panel } from '../../components/Panel';

export function OverviewPage() {
  const healthQuery = useQuery({
    queryKey: ['system-health'],
    queryFn: getSystemHealth,
    refetchInterval: 10_000,
  });
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    refetchInterval: 10_000,
  });

  const healthMetric = healthQuery.isPending
    ? { value: '检查中', detail: '正在等待 API 心跳', tone: 'neutral' as const }
    : healthQuery.isError
      ? { value: '无法连接', detail: 'API 心跳请求失败', tone: 'amber' as const }
      : healthQuery.data.status === 'degraded'
        ? { value: '已降级', detail: 'API 报告服务处于降级状态', tone: 'amber' as const }
        : { value: '在线', detail: 'API 心跳正常', tone: 'cyan' as const };
  const networkCount = networksQuery.data?.total;
  const networkMetric = networksQuery.isPending
    ? { value: '…', detail: '正在加载网络注册表', tone: 'neutral' as const }
    : networksQuery.isError
      ? { value: '异常', detail: '网络注册表不可用', tone: 'amber' as const }
      : {
          value: String(networkCount ?? 0),
          detail: '平台不会注入默认网络',
          tone: 'cyan' as const,
        };

  return (
    <div className="page-stack page-enter">
      <section className="hero">
        <div className="hero__copy">
          <span className="eyebrow">集群控制</span>
          <h1>
            统一控制界面。
            <span>管理每一个 Fabric 网络。</span>
          </h1>
          <p>
            注册相互隔离的网络，观察拓扑与账本活动，并在不向浏览器暴露管理身份的前提下执行受控运维。
          </p>
        </div>
        <div className="hero__telemetry" aria-hidden="true">
          <div className="radar-orbit radar-orbit--outer" />
          <div className="radar-orbit radar-orbit--inner" />
          <div className="radar-core">
            <RadioTower size={28} strokeWidth={1.4} />
          </div>
          <span className="radar-label radar-label--top">注册表</span>
          <span className="radar-label radar-label--right">驱动</span>
          <span className="radar-label radar-label--bottom">事件</span>
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard
          label="已注册网络"
          value={networkMetric.value}
          detail={networkMetric.detail}
          icon={Boxes}
          tone={networkMetric.tone}
        />
        <MetricCard
          label="控制平面"
          value={healthMetric.value}
          detail={healthMetric.detail}
          icon={ShieldCheck}
          tone={healthMetric.tone}
        />
        <MetricCard
          label="活跃运维"
          value="0"
          detail="作业引擎尚未启用"
          icon={Activity}
        />
      </section>

      <div className="dashboard-grid">
        <Panel
          eyebrow="注册表"
          title="网络集群"
          className="panel--fleet"
          action={
            <Link className="text-link" to="/networks">
              打开注册表 <span aria-hidden="true">↗</span>
            </Link>
          }
        >
          {networksQuery.isPending ? (
            <div className="query-state">
              <span className="query-state__spinner" />
              <div>
                <h3>正在加载网络注册表</h3>
                <p>控制平面正在解析已注册的网络定义。</p>
              </div>
            </div>
          ) : networksQuery.isError ? (
            <div className="query-state query-state--error">
              <div>
                <h3>网络注册表不可用</h3>
                <p>API 未返回有效的网络注册表数据。</p>
              </div>
              <button className="secondary-action" type="button" onClick={() => networksQuery.refetch()}>
                重试
              </button>
            </div>
          ) : networkCount === 0 ? (
            <div className="empty-registry">
              <div className="empty-registry__glyph" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div>
                <h3>网络注册表当前为空</h3>
                <p>
                  创建由平台管理的 Fabric 网络或导入已有网络。各网络按工作区、Docker 项目、凭据和运维锁相互隔离。
                </p>
              </div>
              <Link className="primary-action" to="/networks">
                注册网络
              </Link>
            </div>
          ) : (
            <div className="query-state query-state--ready">
              <div>
                <h3>已注册 {networkCount} 个网络</h3>
                <p>打开注册表，查看并选择相互隔离的网络上下文。</p>
              </div>
              <Link className="primary-action" to="/networks">
                查看网络集群
              </Link>
            </div>
          )}
        </Panel>

        <Panel eyebrow="架构" title="控制路径" className="panel--control-path">
          <div className="control-path">
            <div className="control-node control-node--active">
              <span>01</span>
              <strong>注册表</strong>
              <small>网络定义</small>
            </div>
            <div className="control-link" />
            <div className="control-node">
              <span>02</span>
              <strong>驱动</strong>
              <small>隔离适配器</small>
            </div>
            <div className="control-link" />
            <div className="control-node">
              <span>03</span>
              <strong>Fabric</strong>
              <small>网络运行时</small>
            </div>
          </div>
        </Panel>
      </div>

      <Panel eyebrow="活动" title="运维时间线">
        <div className="timeline-empty">
          <span className="timeline-empty__line" />
          <span className="timeline-empty__dot" />
          <div>
            <strong>暂无运维记录</strong>
            <p>网络部署、生命周期变更和合约提交记录将显示在这里。</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
