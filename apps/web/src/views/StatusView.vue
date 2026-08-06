<script setup lang="ts">
import {
  Activity,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  HardDrive,
  RefreshCw,
  WifiOff,
} from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import type { DependencyName, LivenessResponse, ReadinessResponse } from '@dam/contracts';

import { apiRequest } from '../lib/api';

type LoadState = 'idle' | 'loading' | 'complete';

const loadState = ref<LoadState>('idle');
const liveness = ref<LivenessResponse | null>(null);
const readiness = ref<ReadinessResponse | null>(null);
const requestError = ref<string | null>(null);
const lastCheckedAt = ref<Date | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const dependencyMetadata: Record<
  DependencyName,
  { label: string; role: string; icon: typeof Database }
> = {
  database: { label: 'PostgreSQL', role: '元数据与权限', icon: Database },
  redis: { label: 'Redis', role: '缓存与会话', icon: Activity },
  objectStorage: { label: 'MinIO', role: '资产对象存储', icon: HardDrive },
};

const dependencies = computed(() =>
  (Object.keys(dependencyMetadata) as DependencyName[]).map((name) => {
    const health = readiness.value?.dependencies.find((item) => item.name === name);
    return {
      name,
      ...dependencyMetadata[name],
      status: health?.status ?? 'down',
      latencyMs: health?.latencyMs,
    };
  }),
);
const healthyCount = computed(
  () => dependencies.value.filter((item) => item.status === 'up').length,
);
const overallHealthy = computed(
  () => liveness.value?.status === 'ok' && readiness.value?.status === 'ready',
);
const formattedCheckTime = computed(() =>
  lastCheckedAt.value === null
    ? '--'
    : new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(lastCheckedAt.value),
);
const formattedUptime = computed(() => {
  const seconds = liveness.value?.uptimeSeconds;
  if (seconds === undefined) return '--';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
});

async function refreshHealth(): Promise<void> {
  loadState.value = 'loading';
  requestError.value = null;
  try {
    [liveness.value, readiness.value] = await Promise.all([
      apiRequest<LivenessResponse>('/api/v1/health/live', { auth: false }),
      apiRequest<ReadinessResponse>('/api/v1/health/ready', { auth: false }),
    ]);
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : '无法连接 API';
  } finally {
    lastCheckedAt.value = new Date();
    loadState.value = 'complete';
  }
}

onMounted(() => {
  void refreshHealth();
  refreshTimer = setInterval(() => void refreshHealth(), 30_000);
});
onBeforeUnmount(() => refreshTimer && clearInterval(refreshTimer));
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">运行概览</p>
      <h1>系统状态</h1>
    </div>
    <button
      class="icon-button"
      type="button"
      title="刷新系统状态"
      :disabled="loadState === 'loading'"
      @click="refreshHealth"
    >
      <RefreshCw :size="18" :class="{ spinning: loadState === 'loading' }" />
    </button>
  </header>

  <section class="status-strip" :class="overallHealthy ? 'healthy' : 'degraded'">
    <component :is="overallHealthy ? CheckCircle2 : WifiOff" :size="21" />
    <div>
      <strong>{{ overallHealthy ? '所有核心依赖正常' : '系统需要检查' }}</strong
      ><span>{{ requestError ?? '状态每 30 秒自动更新' }}</span>
    </div>
  </section>

  <section class="metric-grid" aria-label="运行指标">
    <article class="metric-card">
      <span class="metric-icon green"><CheckCircle2 :size="19" /></span>
      <div>
        <span>可用依赖</span><strong>{{ healthyCount }} / {{ dependencies.length }}</strong>
      </div>
    </article>
    <article class="metric-card">
      <span class="metric-icon blue"><Clock3 :size="19" /></span>
      <div>
        <span>API 运行时间</span><strong>{{ formattedUptime }}</strong>
      </div>
    </article>
    <article class="metric-card">
      <span class="metric-icon amber"><Activity :size="19" /></span>
      <div>
        <span>最近检查</span><strong>{{ formattedCheckTime }}</strong>
      </div>
    </article>
  </section>

  <section class="page-section">
    <div class="section-heading">
      <div>
        <h2>核心依赖</h2>
        <p>本地基础组件</p>
      </div>
      <a class="inline-link" href="http://localhost:3000/api/docs" target="_blank" rel="noreferrer"
        >API 文档 <ExternalLink :size="15"
      /></a>
    </div>
    <div class="data-table dependency-table" role="table">
      <div class="table-row table-header" role="row">
        <span>服务</span><span>职责</span><span>延迟</span><span>状态</span>
      </div>
      <div v-for="dependency in dependencies" :key="dependency.name" class="table-row" role="row">
        <span class="service-name"
          ><span class="service-icon"><component :is="dependency.icon" :size="18" /></span
          >{{ dependency.label }}</span
        >
        <span class="muted">{{ dependency.role }}</span>
        <span>{{ dependency.latencyMs === undefined ? '--' : `${dependency.latencyMs} ms` }}</span>
        <span
          ><span class="state-label" :class="dependency.status"
            ><span class="state-dot"></span
            >{{ dependency.status === 'up' ? '正常' : '不可用' }}</span
          ></span
        >
      </div>
    </div>
  </section>
</template>
