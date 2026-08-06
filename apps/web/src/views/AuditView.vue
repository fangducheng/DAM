<script setup lang="ts">
import { FileClock, LoaderCircle, RefreshCw, Search } from '@lucide/vue';
import { onMounted, reactive, ref } from 'vue';

import { apiRequest } from '../lib/api';
import { notifyError } from '../stores/notifications';

interface AuditEvent {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  result: string;
  ipAddress: string | null;
  requestId: string | null;
  beforeData: unknown;
  afterData: unknown;
  details: unknown;
  actor: { displayName: string; email: string } | null;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const events = ref<AuditEvent[]>([]);
const loading = ref(true);
const filters = reactive({ action: '', result: '', occurredFrom: '', occurredTo: '' });

async function load(): Promise<void> {
  loading.value = true;
  try {
    const query = new URLSearchParams({ limit: '100' });
    if (filters.action.trim()) query.set('action', filters.action.trim());
    if (filters.result) query.set('result', filters.result);
    if (filters.occurredFrom)
      query.set('occurredFrom', new Date(filters.occurredFrom).toISOString());
    if (filters.occurredTo) query.set('occurredTo', new Date(filters.occurredTo).toISOString());
    events.value = (
      await apiRequest<Page<AuditEvent>>(`/api/v1/audit-events?${query.toString()}`)
    ).items;
  } catch (error) {
    events.value = [];
    notifyError(error, '审计记录加载失败');
  } finally {
    loading.value = false;
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(value),
  );
}

function eventData(event: AuditEvent): string {
  return JSON.stringify(
    { before: event.beforeData, after: event.afterData, details: event.details },
    null,
    2,
  );
}

onMounted(() => void load());
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">合规与追溯</p>
      <h1>审计日志</h1>
    </div>
    <div class="header-actions">
      <button class="icon-button" type="button" title="刷新审计日志" @click="load">
        <RefreshCw :size="18" />
      </button>
    </div>
  </header>

  <form class="audit-toolbar" @submit.prevent="load">
    <label class="field grow"
      ><span>操作</span><input v-model="filters.action" maxlength="120"
    /></label>
    <label class="field"
      ><span>结果</span>
      <select v-model="filters.result">
        <option value="">全部</option>
        <option value="SUCCEEDED">成功</option>
        <option value="FAILED">失败</option>
        <option value="DENIED">拒绝</option>
      </select>
    </label>
    <label class="field"
      ><span>开始时间</span><input v-model="filters.occurredFrom" type="datetime-local"
    /></label>
    <label class="field"
      ><span>结束时间</span><input v-model="filters.occurredTo" type="datetime-local"
    /></label>
    <button class="primary-button compact" type="submit"><Search :size="15" />查询</button>
  </form>

  <section class="page-section audit-section">
    <div v-if="loading" class="loading-state">
      <LoaderCircle class="spinning" :size="21" />加载审计日志
    </div>
    <div v-else-if="events.length === 0" class="empty-state">
      <FileClock :size="27" /><strong>没有匹配的审计记录</strong>
    </div>
    <div v-else class="data-table audit-table">
      <div class="table-row table-header">
        <span>时间</span><span>操作人</span><span>操作</span><span>资源</span><span>结果</span>
      </div>
      <div v-for="event in events" :key="event.id" class="table-row">
        <span>{{ formatTime(event.occurredAt) }}</span>
        <span class="person-cell"
          ><strong>{{ event.actor?.displayName ?? '系统' }}</strong
          ><small>{{ event.ipAddress ?? '--' }}</small></span
        >
        <span class="audit-action"
          ><strong>{{ event.action }}</strong
          ><small>{{ event.requestId ?? '--' }}</small></span
        >
        <span class="audit-resource"
          ><strong>{{ event.resourceType ?? '--' }}</strong
          ><small>{{ event.resourceId ?? '--' }}</small></span
        >
        <span>
          <span
            class="status-badge"
            :class="{
              active: event.result === 'SUCCEEDED',
              disabled: event.result !== 'SUCCEEDED',
            }"
            >{{ event.result }}</span
          >
          <details
            v-if="event.beforeData || event.afterData || event.details"
            class="audit-details"
          >
            <summary>详情</summary>
            <pre>{{ eventData(event) }}</pre>
          </details>
        </span>
      </div>
    </div>
  </section>
</template>
