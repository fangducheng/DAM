<script setup lang="ts">
import { AlertTriangle, DatabaseZap, LoaderCircle, RefreshCw, RotateCcw } from '@lucide/vue';
import { onMounted, reactive, ref } from 'vue';

import ModalDialog from '../components/ModalDialog.vue';
import { apiRequest } from '../lib/api';
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

const jobs = ref<MaintenanceJob[]>([]);
const summary = ref<MaintenanceSummary>({ jobs: {}, deletionBatches: {}, nextDueAt: null });
const loading = ref(true);
const submitting = ref(false);
const retryTarget = ref<MaintenanceJob | null>(null);
const filters = reactive({ status: '', jobType: '' });

async function load(): Promise<void> {
  loading.value = true;
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
    notifyError(error, '维护任务加载失败');
  } finally {
    loading.value = false;
  }
}

async function retry(): Promise<void> {
  if (retryTarget.value === null) return;
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

function count(status: string): number {
  return summary.value.jobs[status] ?? 0;
}

function formatTime(value: string | null): string {
  if (value === null) return '--';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(value),
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
      <h1>维护任务</h1>
    </div>
    <div class="header-actions">
      <button class="icon-button" type="button" title="刷新维护任务" @click="load">
        <RefreshCw :size="18" />
      </button>
    </div>
  </header>

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
    <button class="primary-button compact" type="submit">筛选</button>
  </form>

  <section class="page-section maintenance-section">
    <div v-if="loading" class="loading-state">
      <LoaderCircle class="spinning" :size="21" />加载维护任务
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
            v-if="job.status === 'DEAD'"
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
