<script setup lang="ts">
import { Laptop, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { apiRequest } from '../lib/api';
import type { SessionSummary } from '../lib/types';
import { authStore } from '../stores/auth';
import { notify, notifyError } from '../stores/notifications';

const router = useRouter();
const sessions = ref<SessionSummary[]>([]);
const loading = ref(true);
const revokingId = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    sessions.value = await apiRequest<SessionSummary[]>('/api/v1/identity/sessions');
  } catch (error) {
    notifyError(error, '会话加载失败');
  } finally {
    loading.value = false;
  }
}

async function revoke(session: SessionSummary): Promise<void> {
  revokingId.value = session.id;
  try {
    await apiRequest<void>(`/api/v1/identity/sessions/${session.id}`, { method: 'DELETE' });
    sessions.value = sessions.value.filter((item) => item.id !== session.id);
    notify('success', '会话已撤销');
  } catch (error) {
    notifyError(error, '撤销失败');
  } finally {
    revokingId.value = null;
  }
}

async function revokeAll(): Promise<void> {
  try {
    await apiRequest<{ revokedSessions: number }>('/api/v1/identity/sessions', {
      method: 'DELETE',
    });
    authStore.setAnonymous();
    notify('success', '所有会话已撤销');
    await router.replace('/login');
  } catch (error) {
    notifyError(error, '撤销失败');
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

onMounted(() => void load());
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">账号安全</p>
      <h1>登录会话</h1>
    </div>
    <div class="header-actions">
      <button class="icon-button" type="button" title="刷新会话" @click="load">
        <RefreshCw :size="18" />
      </button>
      <button class="danger-button" type="button" @click="revokeAll">
        <Trash2 :size="16" />撤销全部
      </button>
    </div>
  </header>

  <section class="page-section">
    <div v-if="loading" class="loading-state">
      <LoaderCircle class="spinning" :size="22" />加载会话
    </div>
    <div v-else-if="sessions.length === 0" class="empty-state">
      <ShieldCheck :size="26" /><strong>没有活动会话</strong>
    </div>
    <div v-else class="data-table session-table">
      <div class="table-row table-header">
        <span>设备</span><span>地址</span><span>最近使用</span><span>到期时间</span><span></span>
      </div>
      <div v-for="session in sessions" :key="session.id" class="table-row">
        <span class="service-name"
          ><span class="service-icon"><Laptop :size="18" /></span
          ><span
            ><strong>{{ session.userAgent ?? '未知设备' }}</strong
            ><small v-if="session.current">当前会话</small></span
          ></span
        >
        <span>{{ session.ipAddress ?? '--' }}</span>
        <span>{{ formatDate(session.lastUsedAt) }}</span>
        <span>{{ formatDate(session.expiresAt) }}</span>
        <span class="row-actions"
          ><button
            v-if="!session.current"
            class="icon-button small"
            type="button"
            title="撤销会话"
            :disabled="revokingId === session.id"
            @click="revoke(session)"
          >
            <LoaderCircle v-if="revokingId === session.id" class="spinning" :size="15" /><Trash2
              v-else
              :size="15"
            /></button
        ></span>
      </div>
    </div>
  </section>
</template>
