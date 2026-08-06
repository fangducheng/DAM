<script setup lang="ts">
import { Box, Eye, EyeOff, LoaderCircle, LockKeyhole, UserRound } from '@lucide/vue';
import { onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { ApiClientError } from '../lib/api';
import { authStore } from '../stores/auth';
import { notify, notifyError } from '../stores/notifications';

const route = useRoute();
const router = useRouter();
const form = reactive({ tenantCode: '', identifier: '', password: '' });
const fieldErrors = reactive<Record<string, string>>({});
const submitting = ref(false);
const showPassword = ref(false);

onMounted(() => {
  if (route.query.expired === '1') notify('warning', '登录状态已失效，请重新登录');
});

async function submit(): Promise<void> {
  submitting.value = true;
  clearFieldErrors();
  try {
    const result = await authStore.login(form);
    if (result === 'mfa_required') {
      await router.push('/mfa');
      return;
    }
    await router.replace(
      typeof route.query.redirect === 'string' ? route.query.redirect : '/status',
    );
  } catch (error) {
    if (error instanceof ApiClientError) {
      for (const fieldError of error.fieldErrors)
        fieldErrors[fieldError.field] = fieldError.message;
    }
    notifyError(error, '登录失败');
  } finally {
    submitting.value = false;
  }
}

function clearFieldErrors(): void {
  for (const field of Object.keys(fieldErrors)) delete fieldErrors[field];
}
</script>

<template>
  <main class="auth-layout">
    <section class="auth-panel" aria-labelledby="login-title">
      <header class="auth-brand">
        <span class="brand-mark"><Box :size="20" /></span>
        <div>
          <strong>DAM</strong>
          <span>数字资产中心</span>
        </div>
      </header>

      <div class="auth-heading">
        <h1 id="login-title">登录</h1>
        <p>企业账号安全入口</p>
      </div>

      <form class="form-stack" novalidate @submit.prevent="submit">
        <label class="field">
          <span>协作域代码</span>
          <span class="input-shell" :class="{ invalid: fieldErrors.tenantCode }">
            <LockKeyhole :size="17" />
            <input
              v-model="form.tenantCode"
              name="tenantCode"
              autocomplete="organization"
              required
              autofocus
            />
          </span>
          <small v-if="fieldErrors.tenantCode" class="field-error">{{
            fieldErrors.tenantCode
          }}</small>
        </label>

        <label class="field">
          <span>账号或邮箱</span>
          <span class="input-shell" :class="{ invalid: fieldErrors.identifier }">
            <UserRound :size="17" />
            <input v-model="form.identifier" name="identifier" autocomplete="username" required />
          </span>
          <small v-if="fieldErrors.identifier" class="field-error">{{
            fieldErrors.identifier
          }}</small>
        </label>

        <label class="field">
          <span>密码</span>
          <span class="input-shell" :class="{ invalid: fieldErrors.password }">
            <LockKeyhole :size="17" />
            <input
              v-model="form.password"
              name="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              required
            />
            <button
              type="button"
              class="input-action"
              :title="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <component :is="showPassword ? EyeOff : Eye" :size="17" />
            </button>
          </span>
          <small v-if="fieldErrors.password" class="field-error">{{ fieldErrors.password }}</small>
        </label>

        <button class="primary-button full-width" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="17" />
          <span>{{ submitting ? '登录中' : '登录' }}</span>
        </button>
      </form>

      <footer class="auth-footer">
        <RouterLink to="/invite">接受邀请</RouterLink>
        <span>本地安全环境</span>
      </footer>
    </section>
  </main>
</template>
