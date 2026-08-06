<script setup lang="ts">
import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldX,
  Trash2,
} from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';

import { permissionCodes, type PermissionCode } from '@dam/contracts';

import { apiRequest } from '../lib/api';
import { notify, notifyError } from '../stores/notifications';

type PrincipalType = 'USER' | 'GROUP' | 'ORGANIZATION';
type Effect = 'ALLOW' | 'DENY';

const route = useRoute();

interface AclEntry {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  effect: Effect;
  expiresAt: string | null;
  permission: { code: PermissionCode; name: string };
  createdBy: { id: string; displayName: string };
  sourceNode: { id: string; name: string };
  depth: number;
  inherited: boolean;
}

interface Explanation {
  allowed: boolean;
  reason: 'explicit_deny' | 'explicit_allow' | 'role_allow' | 'default_deny';
  permission: PermissionCode;
  authorizationVersion: string;
  roleCodes: string[];
  matchedAclEntries: Array<{ id: string; effect: Effect; resourceNodeId: string; depth: number }>;
}

const nodePermissions = permissionCodes.filter((code) => code.startsWith('node.'));
const nodeId = ref('');
const includeInherited = ref(true);
const entries = ref<AclEntry[]>([]);
const loading = ref(false);
const loaded = ref(false);
const explanation = ref<Explanation | null>(null);
const form = reactive({
  principalType: 'GROUP' as PrincipalType,
  principalId: '',
  permissionCode: 'node.view' as PermissionCode,
  effect: 'ALLOW' as Effect,
  expiresAt: '',
});
const explainPermission = ref<PermissionCode>('node.view');
const directCount = computed(() => entries.value.filter((entry) => !entry.inherited).length);
const inheritedCount = computed(() => entries.value.filter((entry) => entry.inherited).length);

onMounted(() => {
  const routeNodeId = route.query.nodeId;
  if (typeof routeNodeId === 'string') {
    nodeId.value = routeNodeId;
    void load();
  }
});

async function load(): Promise<void> {
  if (!nodeId.value) return;
  loading.value = true;
  explanation.value = null;
  try {
    const result = await apiRequest<{ items: AclEntry[] }>(
      `/api/v1/resource-nodes/${nodeId.value}/acl?includeInherited=${includeInherited.value}`,
    );
    entries.value = result.items;
    loaded.value = true;
  } catch (error) {
    entries.value = [];
    notifyError(error, 'ACL 加载失败');
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  loading.value = true;
  try {
    await apiRequest(`/api/v1/resource-nodes/${nodeId.value}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        principalType: form.principalType,
        principalId: form.principalId,
        permissionCode: form.permissionCode,
        effect: form.effect,
        ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
      }),
    });
    notify('success', 'ACL 已保存');
    await load();
  } catch (error) {
    notifyError(error, 'ACL 保存失败');
  } finally {
    loading.value = false;
  }
}

async function remove(entry: AclEntry): Promise<void> {
  if (entry.inherited) return;
  try {
    await apiRequest<void>(`/api/v1/resource-nodes/${nodeId.value}/acl/${entry.id}`, {
      method: 'DELETE',
    });
    notify('success', 'ACL 已删除');
    await load();
  } catch (error) {
    notifyError(error, 'ACL 删除失败');
  }
}

async function explain(): Promise<void> {
  try {
    explanation.value = await apiRequest<Explanation>(
      `/api/v1/resource-nodes/${nodeId.value}/permissions/${explainPermission.value}`,
    );
  } catch (error) {
    explanation.value = null;
    notifyError(error, '权限计算失败');
  }
}

function formatExpiry(value: string | null): string {
  return value === null
    ? '长期有效'
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      );
}

const permissionLabels: Record<string, string> = {
  'node.view': '查看',
  'node.preview': '预览',
  'node.download': '下载',
  'node.create': '创建',
  'node.update': '更新',
  'node.delete': '删除',
  'node.permissions.manage': '管理权限',
};
const reasonLabels: Record<Explanation['reason'], string> = {
  explicit_deny: '显式拒绝',
  explicit_allow: '显式允许',
  role_allow: '空间角色允许',
  default_deny: '默认拒绝',
};
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">文件夹与文件</p>
      <h1>目录权限</h1>
    </div>
  </header>

  <section class="permission-toolbar">
    <label class="field grow"
      ><span>资源节点 ID</span
      ><span class="input-shell"
        ><KeyRound :size="17" /><input v-model="nodeId" required @keyup.enter="load" /></span
    ></label>
    <label class="checkbox-field"
      ><input v-model="includeInherited" type="checkbox" />包含继承项</label
    >
    <button class="primary-button" type="button" :disabled="loading || !nodeId" @click="load">
      <LoaderCircle v-if="loading" class="spinning" :size="17" /><Search v-else :size="17" />查询
    </button>
  </section>

  <template v-if="loaded">
    <section class="metric-grid permission-metrics">
      <article class="metric-card">
        <span class="metric-icon blue"><KeyRound :size="19" /></span>
        <div>
          <span>直接授权</span><strong>{{ directCount }}</strong>
        </div>
      </article>
      <article class="metric-card">
        <span class="metric-icon amber"><RefreshCw :size="19" /></span>
        <div>
          <span>继承授权</span><strong>{{ inheritedCount }}</strong>
        </div>
      </article>
    </section>

    <div class="permission-layout">
      <section class="page-section">
        <div class="section-heading">
          <div>
            <h2>访问控制列表</h2>
            <p>{{ entries.length }} 条规则</p>
          </div>
        </div>
        <div class="data-table acl-table">
          <div class="table-row table-header">
            <span>主体</span><span>权限</span><span>效果</span><span>来源</span><span>有效期</span
            ><span></span>
          </div>
          <div v-for="entry in entries" :key="entry.id" class="table-row">
            <span class="person-cell"
              ><strong>{{ entry.principalType }}</strong
              ><small>{{ entry.principalId }}</small></span
            >
            <span>{{ permissionLabels[entry.permission.code] ?? entry.permission.name }}</span>
            <span class="effect-badge" :class="entry.effect.toLowerCase()">{{
              entry.effect === 'ALLOW' ? '允许' : '拒绝'
            }}</span>
            <span class="person-cell"
              ><strong>{{ entry.sourceNode.name }}</strong
              ><small>{{ entry.inherited ? `继承 · ${entry.depth} 层` : '当前节点' }}</small></span
            >
            <span>{{ formatExpiry(entry.expiresAt) }}</span>
            <span class="row-actions"
              ><button
                v-if="!entry.inherited"
                class="icon-button small danger"
                type="button"
                title="删除 ACL"
                @click="remove(entry)"
              >
                <Trash2 :size="15" /></button
            ></span>
          </div>
          <div v-if="entries.length === 0" class="empty-state">
            <KeyRound :size="24" /><strong>暂无 ACL</strong>
          </div>
        </div>
      </section>

      <aside class="permission-editor">
        <section>
          <h2>设置 ACL</h2>
          <form class="form-stack" @submit.prevent="save">
            <label class="field"
              ><span>主体类型</span
              ><select v-model="form.principalType">
                <option value="USER">用户</option>
                <option value="GROUP">群组</option>
                <option value="ORGANIZATION">公司</option>
              </select></label
            >
            <label class="field"
              ><span>主体 ID</span><input v-model="form.principalId" required
            /></label>
            <div class="form-grid two-columns">
              <label class="field"
                ><span>权限</span
                ><select v-model="form.permissionCode">
                  <option
                    v-for="permission in nodePermissions"
                    :key="permission"
                    :value="permission"
                  >
                    {{ permissionLabels[permission] }}
                  </option>
                </select></label
              ><label class="field"
                ><span>效果</span
                ><select v-model="form.effect">
                  <option value="ALLOW">允许</option>
                  <option value="DENY">拒绝</option>
                </select></label
              >
            </div>
            <label class="field"
              ><span>到期时间</span><input v-model="form.expiresAt" type="datetime-local"
            /></label>
            <button class="primary-button full-width" type="submit" :disabled="loading">
              保存 ACL
            </button>
          </form>
        </section>

        <section class="explanation-panel">
          <h2>权限来源</h2>
          <div class="inline-form">
            <select v-model="explainPermission">
              <option v-for="permission in nodePermissions" :key="permission" :value="permission">
                {{ permissionLabels[permission] }}
              </option></select
            ><button class="secondary-button" type="button" @click="explain">计算</button>
          </div>
          <div
            v-if="explanation"
            class="decision"
            :class="explanation.allowed ? 'allowed' : 'denied'"
          >
            <component :is="explanation.allowed ? CheckCircle2 : ShieldX" :size="20" />
            <div>
              <strong>{{ explanation.allowed ? '允许访问' : '拒绝访问' }}</strong
              ><span>{{ reasonLabels[explanation.reason] }}</span>
            </div>
          </div>
          <div v-if="explanation" class="explanation-meta">
            <span>角色：{{ explanation.roleCodes.join(', ') || '--' }}</span
            ><span>ACL 命中：{{ explanation.matchedAclEntries.length }}</span
            ><span>授权版本：{{ explanation.authorizationVersion }}</span>
          </div>
        </section>
      </aside>
    </div>
  </template>

  <div v-else class="empty-state permission-empty">
    <KeyRound :size="28" /><strong>输入资源节点后查询</strong>
  </div>
</template>
