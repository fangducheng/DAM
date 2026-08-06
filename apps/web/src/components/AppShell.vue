<script setup lang="ts">
import {
  Box,
  Building2,
  FolderKanban,
  KeyRound,
  LogOut,
  Server,
  ShieldCheck,
  UsersRound,
} from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';

import { authStore } from '../stores/auth';
import { notify, notifyError } from '../stores/notifications';

const route = useRoute();
const router = useRouter();
const viewRevision = ref(0);

const navigation = [
  { to: '/status', label: '系统状态', icon: Server },
  { to: '/organizations', label: '组织与成员', icon: Building2 },
  { to: '/groups', label: '共享群组', icon: UsersRound },
  { to: '/spaces', label: '业务空间', icon: FolderKanban },
  { to: '/permissions', label: '目录权限', icon: KeyRound },
  { to: '/sessions', label: '登录会话', icon: ShieldCheck },
];

const currentTitle = computed(
  () => navigation.find((item) => route.path.startsWith(item.to))?.label ?? '数字资产中心',
);

async function logout(): Promise<void> {
  try {
    await authStore.logout();
    notify('success', '已安全退出');
    await router.replace('/login');
  } catch (error) {
    notifyError(error, '退出失败');
  }
}

function refreshCurrentView(): void {
  viewRevision.value += 1;
}

onMounted(() => window.addEventListener('dam:data-conflict', refreshCurrentView));
onBeforeUnmount(() => window.removeEventListener('dam:data-conflict', refreshCurrentView));
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/status" aria-label="数字资产中心">
        <span class="brand-mark"><Box :size="19" aria-hidden="true" /></span>
        <span class="brand-copy">
          <strong>DAM</strong>
          <small>数字资产中心</small>
        </span>
      </RouterLink>

      <nav class="primary-nav" aria-label="主导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          class="nav-item"
          :to="item.to"
          :title="item.label"
        >
          <component :is="item.icon" :size="18" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <span class="user-avatar">{{
          authStore.state.user?.userId.slice(0, 2).toUpperCase()
        }}</span>
        <span class="user-context">
          <small>当前账号</small>
          <strong>{{ authStore.state.user?.userId.slice(0, 8) }}</strong>
        </span>
        <button class="sidebar-action" type="button" title="退出登录" @click="logout">
          <LogOut :size="17" />
        </button>
      </div>
    </aside>

    <div class="workspace">
      <header class="mobile-topbar">
        <strong>{{ currentTitle }}</strong>
        <button class="icon-button" type="button" title="退出登录" @click="logout">
          <LogOut :size="18" />
        </button>
      </header>
      <main class="main-content">
        <RouterView :key="`${route.fullPath}:${viewRevision}`" />
      </main>
    </div>
  </div>
</template>
