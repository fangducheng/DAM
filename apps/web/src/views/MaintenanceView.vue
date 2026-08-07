<script setup lang="ts">
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  DatabaseZap,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ScanSearch,
} from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';

import ModalDialog from '../components/ModalDialog.vue';
import { apiRequest } from '../lib/api';
import { authStore } from '../stores/auth';
import { notify, notifyError } from '../stores/notifications';

interface MaintenanceJob {
  id: string;
  spaceId: string | null;
  jobType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface MaintenanceSummary {
  jobs: Record<string, number>;
  deletionBatches: Record<string, number>;
  nextDueAt: string | null;
}

interface ReconciliationSummary {
  databaseObjects: number;
  storageObjects: number;
  missingObjects: number;
  unknownObjects: number;
}

type ReconciliationIssue =
  | {
      id: string;
      issueType: 'DATABASE_OBJECT_MISSING';
      storageObjectId: string;
      expectedSizeBytes: string;
      databaseCreatedAt: string;
    }
  | {
      id: string;
      issueType: 'STORAGE_OBJECT_UNKNOWN';
      objectFingerprint: string;
      observedSizeBytes: string;
      lastModifiedAt: string;
    };

interface ReconciliationReport {
  generatedAt: string;
  summary: ReconciliationSummary;
  items: ReconciliationIssue[];
  nextCursor: string | null;
}

type MaintenanceMode = 'jobs' | 'reconciliation';

interface ReconciliationNavigation {
  cursor: string | null;
  history: Array<string | null>;
}

const jobs = ref<MaintenanceJob[]>([]);
const summary = ref<MaintenanceSummary>({ jobs: {}, deletionBatches: {}, nextDueAt: null });
const loading = ref(true);
const loadError = ref('');
const submitting = ref(false);
const retryTarget = ref<MaintenanceJob | null>(null);
const filters = reactive({ status: '', jobType: '' });
const canManage = computed(() => authStore.hasPermission('maintenance.manage'));
const activeMode = ref<MaintenanceMode>('jobs');
const reconciliation = ref<ReconciliationReport | null>(null);
const reconciliationLoading = ref(false);
const reconciliationError = ref('');
const reconciliationCursor = ref<string | null>(null);
const reconciliationCursorHistory = ref<Array<string | null>>([]);
const reconciliationRetryTarget = ref<ReconciliationNavigation | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const query = new URLSearchParams({ limit: '100' });
    if (filters.status) query.set('status', filters.status);
    if (filters.jobType) query.set('jobType', filters.jobType);
    const [summaryResponse, page] = await Promise.all([
      apiRequest<MaintenanceSummary>('/api/v1/maintenance/summary'),
      apiRequest<Page<MaintenanceJob>>(`/api/v1/maintenance/jobs?${query.toString()}`),
    ]);
    summary.value = summaryResponse;
    jobs.value = page.items;
  } catch (error) {
    jobs.value = [];
    summary.value = { jobs: {}, deletionBatches: {}, nextDueAt: null };
    loadError.value = '维护任务暂时无法加载，请检查网络后重试';
    notifyError(error, '维护任务加载失败');
  } finally {
    loading.value = false;
  }
}

async function retry(): Promise<void> {
  if (retryTarget.value === null || !canManage.value) return;
  submitting.value = true;
  try {
    await apiRequest(`/api/v1/maintenance/jobs/${retryTarget.value.id}/retry`, { method: 'POST' });
    retryTarget.value = null;
    notify('success', '维护任务已重新排队');
    await load();
  } catch (error) {
    notifyError(error, '任务重试失败');
  } finally {
    submitting.value = false;
  }
}

async function selectMode(mode: MaintenanceMode): Promise<void> {
  activeMode.value = mode;
  if (mode === 'reconciliation' && reconciliation.value === null && !reconciliationLoading.value) {
    await loadReconciliation({ cursor: null, history: [] });
  }
}

async function refreshCurrent(): Promise<void> {
  if (activeMode.value === 'jobs') {
    await load();
    return;
  }
  await loadReconciliation({ cursor: null, history: [] });
}

async function loadReconciliation(target?: ReconciliationNavigation): Promise<void> {
  const navigation = target ?? {
    cursor: reconciliationCursor.value,
    history: [...reconciliationCursorHistory.value],
  };
  reconciliationLoading.value = true;
  reconciliationError.value = '';
  reconciliationRetryTarget.value = null;
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (navigation.cursor !== null) {
      query.set('cursor', navigation.cursor);
    }
    const report = await apiRequest<ReconciliationReport>(
      `/api/v1/maintenance/storage-reconciliation?${query.toString()}`,
    );
    reconciliation.value = report;
    reconciliationCursor.value = navigation.cursor;
    reconciliationCursorHistory.value = [...navigation.history];
  } catch (error) {
    reconciliationError.value = '存储对账报告暂时无法生成，请检查对象存储后重试';
    reconciliationRetryTarget.value = navigation;
    notifyError(error, '存储对账失败');
  } finally {
    reconciliationLoading.value = false;
  }
}

async function retryReconciliation(): Promise<void> {
  if (reconciliationRetryTarget.value === null || reconciliationLoading.value) return;
  await loadReconciliation(reconciliationRetryTarget.value);
}

async function nextReconciliationPage(): Promise<void> {
  const nextCursor = reconciliation.value?.nextCursor;
  if (nextCursor === null || nextCursor === undefined || reconciliationLoading.value) return;
  await loadReconciliation({
    cursor: nextCursor,
    history: [...reconciliationCursorHistory.value, reconciliationCursor.value],
  });
}

async function previousReconciliationPage(): Promise<void> {
  if (reconciliationCursorHistory.value.length === 0 || reconciliationLoading.value) return;
  const previousCursor =
    reconciliationCursorHistory.value[reconciliationCursorHistory.value.length - 1] ?? null;
  await loadReconciliation({
    cursor: previousCursor,
    history: reconciliationCursorHistory.value.slice(0, -1),
  });
}

function count(status: string): number {
  return summary.value.jobs[status] ?? 0;
}

function formatTime(value: string | null): string {
  if (value === null) return '--';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(value),
  );
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return `${value} B`;
  if (bytes < 1024) return `${bytes.toLocaleString('zh-CN')} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 'B';
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024) break;
  }
  return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${unit}`;
}

function issueIdentifier(issue: ReconciliationIssue): string {
  return issue.issueType === 'DATABASE_OBJECT_MISSING'
    ? issue.storageObjectId
    : issue.objectFingerprint;
}

function issueSize(issue: ReconciliationIssue): string {
  return formatBytes(
    issue.issueType === 'DATABASE_OBJECT_MISSING'
      ? issue.expectedSizeBytes
      : issue.observedSizeBytes,
  );
}

function issueTime(issue: ReconciliationIssue): string {
  return formatTime(
    issue.issueType === 'DATABASE_OBJECT_MISSING' ? issue.databaseCreatedAt : issue.lastModifiedAt,
  );
}

function statusLabel(status: string): string {
  return (
    {
      PENDING: '等待执行',
      RUNNING: '执行中',
      SUCCEEDED: '已完成',
      FAILED: '失败',
      DEAD: '终态失败',
      CANCELLED: '已取消',
    }[status] ?? status
  );
}

function jobLabel(type: string): string {
  return (
    {
      EXPIRE_UPLOAD_SESSION: '关闭过期上传',
      RETENTION_WARNING: '回收站到期提醒',
      PURGE_DELETION_BATCH: '永久删除资源',
      DELETE_STORAGE_OBJECT: '删除存储对象',
      PRUNE_NOTIFICATIONS: '清理历史通知',
      PRUNE_COMPLETED_JOBS: '清理历史任务',
    }[type] ?? type
  );
}

onMounted(() => void load());
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">数据生命周期</p>
      <h1>生命周期维护</h1>
    </div>
    <div class="header-actions">
      <button
        class="icon-button"
        type="button"
        :title="activeMode === 'jobs' ? '刷新维护任务' : '重新生成存储对账报告'"
        :disabled="loading || reconciliationLoading"
        @click="refreshCurrent"
      >
        <RefreshCw :size="18" />
      </button>
    </div>
  </header>

  <nav class="maintenance-mode-tabs" aria-label="维护视图">
    <button
      type="button"
      :class="{ active: activeMode === 'jobs' }"
      :aria-current="activeMode === 'jobs' ? 'page' : undefined"
      @click="selectMode('jobs')"
    >
      <DatabaseZap :size="16" />任务队列
    </button>
    <button
      type="button"
      :class="{ active: activeMode === 'reconciliation' }"
      :aria-current="activeMode === 'reconciliation' ? 'page' : undefined"
      @click="selectMode('reconciliation')"
    >
      <ScanSearch :size="16" />存储对账
    </button>
  </nav>

  <template v-if="activeMode === 'jobs'">
    <section class="metric-grid maintenance-metrics" aria-label="维护任务摘要">
      <article>
        <small>等待执行</small><strong>{{ count('PENDING') }}</strong>
      </article>
      <article>
        <small>执行中</small><strong>{{ count('RUNNING') }}</strong>
      </article>
      <article>
        <small>终态失败</small><strong>{{ count('DEAD') }}</strong>
      </article>
      <article>
        <small>下次执行</small
        ><strong class="metric-time">{{ formatTime(summary.nextDueAt) }}</strong>
      </article>
    </section>

    <form class="audit-toolbar maintenance-toolbar" @submit.prevent="load">
      <label class="field"
        ><span>状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option value="PENDING">等待执行</option>
          <option value="RUNNING">执行中</option>
          <option value="SUCCEEDED">已完成</option>
          <option value="FAILED">失败</option>
          <option value="DEAD">终态失败</option>
          <option value="CANCELLED">已取消</option>
        </select>
      </label>
      <label class="field grow"
        ><span>任务类型</span>
        <select v-model="filters.jobType">
          <option value="">全部</option>
          <option value="PURGE_DELETION_BATCH">永久删除资源</option>
          <option value="DELETE_STORAGE_OBJECT">删除存储对象</option>
          <option value="EXPIRE_UPLOAD_SESSION">关闭过期上传</option>
          <option value="RETENTION_WARNING">回收站到期提醒</option>
          <option value="PRUNE_NOTIFICATIONS">清理历史通知</option>
          <option value="PRUNE_COMPLETED_JOBS">清理历史任务</option>
        </select>
      </label>
      <button class="primary-button compact" type="submit" :disabled="loading">筛选</button>
    </form>

    <section class="page-section maintenance-section">
      <div v-if="loading" class="loading-state">
        <LoaderCircle class="spinning" :size="21" />加载维护任务
      </div>
      <div v-else-if="loadError" class="empty-state error-state" role="alert">
        <AlertTriangle :size="27" /><strong>{{ loadError }}</strong>
        <button class="secondary-button compact" type="button" @click="load">
          <RefreshCw :size="15" />重新加载
        </button>
      </div>
      <div v-else-if="jobs.length === 0" class="empty-state">
        <DatabaseZap :size="27" /><strong>没有匹配的维护任务</strong>
      </div>
      <div v-else class="data-table maintenance-table">
        <div class="table-row table-header">
          <span>任务</span><span>状态</span><span>尝试次数</span><span>计划/完成时间</span
          ><span>错误</span><span></span>
        </div>
        <div v-for="job in jobs" :key="job.id" class="table-row">
          <span class="maintenance-job-name"
            ><strong>{{ jobLabel(job.jobType) }}</strong
            ><small
              >{{ job.id.slice(0, 8) }} · {{ job.spaceId?.slice(0, 8) ?? '租户级' }}</small
            ></span
          >
          <span>
            <span
              class="status-badge"
              :class="{
                active: job.status === 'SUCCEEDED',
                disabled: job.status === 'DEAD' || job.status === 'FAILED',
              }"
              >{{ statusLabel(job.status) }}</span
            >
          </span>
          <span data-label="尝试次数">{{ job.attempts }} / {{ job.maxAttempts }}</span>
          <span class="maintenance-time" data-label="计划/完成时间">
            <strong>{{ formatTime(job.completedAt ?? job.availableAt) }}</strong>
            <small>更新 {{ formatTime(job.updatedAt) }}</small>
          </span>
          <span class="maintenance-error" data-label="错误">{{ job.errorMessage ?? '--' }}</span>
          <span class="row-actions">
            <button
              v-if="job.status === 'DEAD' && canManage"
              class="secondary-button compact"
              type="button"
              @click="retryTarget = job"
            >
              <RotateCcw :size="15" />重试
            </button>
          </span>
        </div>
      </div>
    </section>
  </template>

  <template v-else>
    <section
      v-if="reconciliation !== null"
      class="metric-grid maintenance-metrics reconciliation-metrics"
      aria-label="存储对账摘要"
    >
      <article>
        <small>数据库对象数</small><strong>{{ reconciliation.summary.databaseObjects }}</strong>
      </article>
      <article>
        <small>存储对象数</small><strong>{{ reconciliation.summary.storageObjects }}</strong>
      </article>
      <article :class="{ 'metric-warning': reconciliation.summary.missingObjects > 0 }">
        <small>数据库记录缺失对象</small
        ><strong>{{ reconciliation.summary.missingObjects }}</strong>
      </article>
      <article :class="{ 'metric-warning': reconciliation.summary.unknownObjects > 0 }">
        <small>存储中未知对象</small><strong>{{ reconciliation.summary.unknownObjects }}</strong>
      </article>
    </section>

    <div v-if="reconciliation !== null" class="reconciliation-meta">
      <span>报告生成于 {{ formatTime(reconciliation.generatedAt) }}</span>
      <span>未知对象仅报告，不会自动删除</span>
    </div>

    <section class="page-section maintenance-section reconciliation-section">
      <div v-if="reconciliationLoading && reconciliation === null" class="loading-state">
        <LoaderCircle class="spinning" :size="21" />正在核对数据库与对象存储
      </div>
      <div
        v-else-if="reconciliationError && reconciliation === null"
        class="empty-state error-state"
        role="alert"
      >
        <AlertTriangle :size="27" /><strong>{{ reconciliationError }}</strong>
        <button class="secondary-button compact" type="button" @click="retryReconciliation">
          <RefreshCw :size="15" />重新生成
        </button>
      </div>
      <template v-else-if="reconciliation !== null">
        <div
          v-if="reconciliationError"
          class="status-strip degraded reconciliation-inline-error"
          role="alert"
        >
          <AlertTriangle :size="21" />
          <div>
            <strong>{{ reconciliationError }}</strong>
            <span>当前页内容已保留，可重试请求或重新生成报告。</span>
          </div>
          <button class="secondary-button compact" type="button" @click="retryReconciliation">
            <RefreshCw :size="15" />重试请求
          </button>
        </div>
        <div v-if="reconciliationLoading" class="reconciliation-progress" aria-live="polite">
          <LoaderCircle class="spinning" :size="16" />正在加载目标页
        </div>
        <div class="data-table reconciliation-table">
          <div v-if="reconciliation.items.length === 0" class="empty-state">
            <HardDrive :size="27" /><strong>未发现存储差异</strong>
          </div>
          <template v-else>
            <div class="table-row table-header">
              <span>差异类型</span><span>安全标识</span><span>对象大小</span><span>记录时间</span>
            </div>
            <div v-for="issue in reconciliation.items" :key="issue.id" class="table-row">
              <span>
                <span
                  class="status-badge disabled"
                  :class="{ unknown: issue.issueType === 'STORAGE_OBJECT_UNKNOWN' }"
                  >{{
                    issue.issueType === 'DATABASE_OBJECT_MISSING'
                      ? '数据库对象缺失'
                      : '未知存储对象'
                  }}</span
                >
              </span>
              <span class="reconciliation-identifier" data-label="安全标识">
                <small>{{
                  issue.issueType === 'DATABASE_OBJECT_MISSING' ? '数据库对象 UUID' : '未知对象指纹'
                }}</small>
                <code>{{ issueIdentifier(issue) }}</code>
              </span>
              <span data-label="对象大小">{{ issueSize(issue) }}</span>
              <span data-label="记录时间">{{ issueTime(issue) }}</span>
            </div>
          </template>
          <footer class="reconciliation-pagination" aria-label="存储对账分页">
            <span>第 {{ reconciliationCursorHistory.length + 1 }} 页</span>
            <div>
              <button
                class="secondary-button compact"
                type="button"
                :disabled="reconciliationCursorHistory.length === 0 || reconciliationLoading"
                @click="previousReconciliationPage"
              >
                <ChevronLeft :size="15" />上一页
              </button>
              <button
                class="secondary-button compact"
                type="button"
                :disabled="reconciliation.nextCursor === null || reconciliationLoading"
                @click="nextReconciliationPage"
              >
                下一页<ChevronRight :size="15" />
              </button>
            </div>
          </footer>
        </div>
      </template>
    </section>
  </template>

  <ModalDialog v-if="retryTarget" title="重试维护任务" @close="retryTarget = null">
    <div class="confirm-content">
      <AlertTriangle :size="24" />
      <div>
        <strong>{{ jobLabel(retryTarget.jobType) }}</strong>
        <p>任务会从第一次尝试重新排队，执行结果仍会写入审计日志。</p>
      </div>
    </div>
    <div class="modal-actions">
      <button class="secondary-button" type="button" @click="retryTarget = null">取消</button>
      <button class="primary-button" type="button" :disabled="submitting" @click="retry">
        <LoaderCircle v-if="submitting" class="spinning" :size="16" />确认重试
      </button>
    </div>
  </ModalDialog>
</template>
