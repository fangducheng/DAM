<script setup lang="ts">
import {
  Activity,
  Box,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  HardDrive,
  RefreshCw,
  Server,
  WifiOff,
} from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import type {
  DependencyHealth,
  DependencyName,
  LivenessResponse,
  ReadinessResponse,
} from '@dam/contracts';

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
      detail: health?.detail,
    };
  }),
);

const healthyCount = computed(
  () => dependencies.value.filter((dependency) => dependency.status === 'up').length,
);
const overallHealthy = computed(
  () => liveness.value?.status === 'ok' && readiness.value?.status === 'ready',
);

const formattedCheckTime = computed(() => {
  if (!lastCheckedAt.value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(lastCheckedAt.value);
});

const formattedUptime = computed(() => {
  const seconds = liveness.value?.uptimeSeconds;
  if (seconds === undefined) return '--';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
});

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = (await response.json()) as T;
  if (!response.ok && response.status !== 503) {
    throw new Error(`请求失败 (${response.status})`);
  }
  return body;
}

async function refreshHealth(): Promise<void> {
  loadState.value = 'loading';
  requestError.value = null;
  try {
    const [liveResult, readyResult] = await Promise.all([
      requestJson<LivenessResponse>('/api/v1/health/live'),
      requestJson<ReadinessResponse>('/api/v1/health/ready'),
    ]);
    liveness.value = liveResult;
    readiness.value = readyResult;
  } catch (error) {
    liveness.value = null;
    readiness.value = null;
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

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark"><Box :size="19" aria-hidden="true" /></span>
        <span class="brand-copy">
          <strong>DAM</strong>
          <small>数字资产中心</small>
        </span>
      </div>

      <nav class="primary-nav" aria-label="主导航">
        <a class="nav-item active" href="#status" aria-current="page">
          <Server :size="18" aria-hidden="true" />
          <span>系统状态</span>
        </a>
      </nav>

      <div class="sidebar-footer">
        <span class="environment-dot" aria-hidden="true"></span>
        <span>
          <small>环境</small>
          <strong>本地开发</strong>
        </span>
      </div>
    </aside>

    <main id="status" class="main-content">
      <header class="topbar">
        <div>
          <p class="eyebrow">运行概览</p>
          <h1>系统状态</h1>
        </div>
        <button
          class="icon-button"
          type="button"
          title="刷新系统状态"
          aria-label="刷新系统状态"
          :disabled="loadState === 'loading'"
          @click="refreshHealth"
        >
          <RefreshCw :size="18" :class="{ spinning: loadState === 'loading' }" />
        </button>
      </header>

      <section class="status-strip" :class="overallHealthy ? 'healthy' : 'degraded'">
        <component :is="overallHealthy ? CheckCircle2 : WifiOff" :size="21" aria-hidden="true" />
        <div>
          <strong>{{ overallHealthy ? '所有核心依赖正常' : '系统需要检查' }}</strong>
          <span>{{ requestError ?? '状态每 30 秒自动更新' }}</span>
        </div>
      </section>

      <section class="metric-grid" aria-label="运行指标">
        <article class="metric-card">
          <span class="metric-icon green"><CheckCircle2 :size="19" /></span>
          <div>
            <span>可用依赖</span>
            <strong>{{ healthyCount }} / {{ dependencies.length }}</strong>
          </div>
        </article>
        <article class="metric-card">
          <span class="metric-icon blue"><Clock3 :size="19" /></span>
          <div>
            <span>API 运行时间</span>
            <strong>{{ formattedUptime }}</strong>
          </div>
        </article>
        <article class="metric-card">
          <span class="metric-icon amber"><Activity :size="19" /></span>
          <div>
            <span>最近检查</span>
            <strong>{{ formattedCheckTime }}</strong>
          </div>
        </article>
      </section>

      <section class="dependency-section">
        <div class="section-heading">
          <div>
            <h2>核心依赖</h2>
            <p>应用启动与资产服务所需的基础组件</p>
          </div>
          <a
            class="docs-link"
            href="http://localhost:3000/api/docs"
            target="_blank"
            rel="noreferrer"
          >
            API 文档
            <ExternalLink :size="15" aria-hidden="true" />
          </a>
        </div>

        <div class="dependency-table" role="table" aria-label="核心依赖状态">
          <div class="table-row table-header" role="row">
            <span role="columnheader">服务</span>
            <span role="columnheader">职责</span>
            <span role="columnheader">延迟</span>
            <span role="columnheader">状态</span>
          </div>
          <div
            v-for="dependency in dependencies"
            :key="dependency.name"
            class="table-row"
            role="row"
          >
            <span class="service-name" role="cell">
              <span class="service-icon"><component :is="dependency.icon" :size="18" /></span>
              {{ dependency.label }}
            </span>
            <span class="service-role" role="cell">{{ dependency.role }}</span>
            <span role="cell">{{
              dependency.latencyMs === undefined ? '--' : `${dependency.latencyMs} ms`
            }}</span>
            <span role="cell">
              <span class="state-label" :class="dependency.status">
                <span class="state-dot" aria-hidden="true"></span>
                {{ dependency.status === 'up' ? '正常' : '不可用' }}
              </span>
            </span>
          </div>
        </div>
      </section>

      <footer class="page-footer">
        <span>Enterprise DAM {{ liveness?.version ?? '0.1.0' }}</span>
        <span>API · NestJS / Fastify</span>
      </footer>
    </main>
  </div>
</template>
