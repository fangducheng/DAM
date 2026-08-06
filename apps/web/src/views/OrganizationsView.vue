<script setup lang="ts">
import {
  Building2,
  Check,
  ClipboardCopy,
  LoaderCircle,
  Plus,
  RefreshCw,
  UserMinus,
  UserPlus,
} from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';

import ModalDialog from '../components/ModalDialog.vue';
import { apiRequest } from '../lib/api';
import { notify, notifyError } from '../stores/notifications';

interface Organization {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  parentOrganizationId: string | null;
  _count: { memberships: number; groups: number; ownedSpaces: number };
}

interface OrganizationMember {
  userId: string;
  title: string | null;
  isPrimary: boolean;
  status: 'ACTIVE' | 'DISABLED';
  roleCode: 'organization_admin' | 'organization_member' | null;
  user: { loginName: string; email: string; displayName: string; status: string };
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const organizations = ref<Organization[]>([]);
const selectedId = ref<string | null>(null);
const members = ref<OrganizationMember[]>([]);
const loading = ref(true);
const loadingMembers = ref(false);
const showCreate = ref(false);
const showInvite = ref(false);
const submitting = ref(false);
const invitationToken = ref<string | null>(null);
const createForm = reactive({ code: '', name: '', parentOrganizationId: '' });
const inviteForm = reactive({
  email: '',
  loginName: '',
  displayName: '',
  initialRoleCode: 'organization_member',
});

const selected = computed(
  () => organizations.value.find((item) => item.id === selectedId.value) ?? null,
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const page = await apiRequest<Page<Organization>>('/api/v1/organizations?limit=100');
    organizations.value = page.items;
    if (selectedId.value === null || !page.items.some((item) => item.id === selectedId.value)) {
      selectedId.value = page.items[0]?.id ?? null;
    }
    await loadMembers();
  } catch (error) {
    notifyError(error, '组织加载失败');
  } finally {
    loading.value = false;
  }
}

async function selectOrganization(id: string): Promise<void> {
  selectedId.value = id;
  await loadMembers();
}

async function loadMembers(): Promise<void> {
  if (selectedId.value === null) {
    members.value = [];
    return;
  }
  loadingMembers.value = true;
  try {
    members.value = (
      await apiRequest<Page<OrganizationMember>>(
        `/api/v1/organizations/${selectedId.value}/members?limit=100`,
      )
    ).items;
  } catch (error) {
    members.value = [];
    notifyError(error, '成员加载失败');
  } finally {
    loadingMembers.value = false;
  }
}

async function createOrganization(): Promise<void> {
  submitting.value = true;
  try {
    const created = await apiRequest<Organization>('/api/v1/organizations', {
      method: 'POST',
      body: JSON.stringify({
        code: createForm.code,
        name: createForm.name,
        ...(createForm.parentOrganizationId
          ? { parentOrganizationId: createForm.parentOrganizationId }
          : {}),
      }),
    });
    showCreate.value = false;
    notify('success', '公司已创建');
    await load();
    await selectOrganization(created.id);
  } catch (error) {
    notifyError(error, '创建失败');
  } finally {
    submitting.value = false;
  }
}

async function toggleOrganization(organization: Organization): Promise<void> {
  try {
    await apiRequest(`/api/v1/organizations/${organization.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: organization.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }),
    });
    notify('success', organization.status === 'ACTIVE' ? '公司已停用' : '公司已启用');
    await load();
  } catch (error) {
    notifyError(error, '状态更新失败');
  }
}

async function updateMember(member: OrganizationMember): Promise<void> {
  try {
    await apiRequest(`/api/v1/organizations/${selectedId.value}/members/${member.userId}`, {
      method: 'PUT',
      body: JSON.stringify({
        roleCode: member.roleCode ?? 'organization_member',
        title: member.title,
        isPrimary: member.isPrimary,
        status: member.status,
      }),
    });
    notify('success', '成员任职已更新');
    await loadMembers();
  } catch (error) {
    notifyError(error, '成员更新失败');
    await loadMembers();
  }
}

async function removeMember(member: OrganizationMember): Promise<void> {
  try {
    await apiRequest<void>(`/api/v1/organizations/${selectedId.value}/members/${member.userId}`, {
      method: 'DELETE',
    });
    notify('success', '成员任职已停用');
    await loadMembers();
  } catch (error) {
    notifyError(error, '成员停用失败');
  }
}

async function createInvitation(): Promise<void> {
  if (selectedId.value === null) return;
  submitting.value = true;
  try {
    const invitation = await apiRequest<{ id: string; token: string; expiresAt: string }>(
      '/api/v1/identity/invitations',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'ORGANIZATION_MEMBER',
          organizationId: selectedId.value,
          ...inviteForm,
        }),
      },
    );
    invitationToken.value = invitation.token;
    notify('success', '邀请已创建');
  } catch (error) {
    notifyError(error, '邀请创建失败');
  } finally {
    submitting.value = false;
  }
}

async function copyInvitation(): Promise<void> {
  if (invitationToken.value === null) return;
  const url = `${window.location.origin}/invite?token=${encodeURIComponent(invitationToken.value)}`;
  await navigator.clipboard.writeText(url);
  notify('success', '邀请链接已复制');
}

onMounted(() => void load());
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">协作域结构</p>
      <h1>组织与成员</h1>
    </div>
    <div class="header-actions">
      <button class="icon-button" type="button" title="刷新" @click="load">
        <RefreshCw :size="18" />
      </button>
      <button class="primary-button" type="button" @click="showCreate = true">
        <Plus :size="17" />新建公司
      </button>
    </div>
  </header>

  <div class="master-detail">
    <section class="master-pane" aria-label="公司列表">
      <div v-if="loading" class="loading-state">
        <LoaderCircle class="spinning" :size="20" />加载中
      </div>
      <button
        v-for="organization in organizations"
        v-else
        :key="organization.id"
        type="button"
        class="master-row"
        :class="{ selected: selectedId === organization.id }"
        @click="selectOrganization(organization.id)"
      >
        <span class="row-icon"><Building2 :size="18" /></span>
        <span
          ><strong>{{ organization.name }}</strong
          ><small>{{ organization.code }}</small></span
        >
        <span class="status-badge" :class="organization.status.toLowerCase()">{{
          organization.status === 'ACTIVE' ? '启用' : '停用'
        }}</span>
      </button>
      <div v-if="!loading && organizations.length === 0" class="empty-state">
        <Building2 :size="25" /><strong>暂无公司</strong>
      </div>
    </section>

    <section class="detail-pane">
      <template v-if="selected">
        <header class="detail-header">
          <div>
            <h2>{{ selected.name }}</h2>
            <p>
              {{ selected.code }} · {{ selected._count.memberships }} 名成员 ·
              {{ selected._count.ownedSpaces }} 个空间
            </p>
          </div>
          <div class="header-actions">
            <button class="secondary-button" type="button" @click="showInvite = true">
              <UserPlus :size="16" />邀请成员
            </button>
            <button class="text-button" type="button" @click="toggleOrganization(selected)">
              {{ selected.status === 'ACTIVE' ? '停用公司' : '启用公司' }}
            </button>
          </div>
        </header>
        <div v-if="loadingMembers" class="loading-state">
          <LoaderCircle class="spinning" :size="20" />加载成员
        </div>
        <div v-else class="data-table member-table">
          <div class="table-row table-header">
            <span>成员</span><span>角色</span><span>职务</span><span>主任职</span><span></span>
          </div>
          <div v-for="member in members" :key="member.userId" class="table-row">
            <span class="person-cell"
              ><strong>{{ member.user.displayName }}</strong
              ><small>{{ member.user.email }}</small></span
            >
            <span
              ><select v-model="member.roleCode">
                <option value="organization_admin">公司管理员</option>
                <option value="organization_member">公司成员</option>
              </select></span
            >
            <span><input v-model="member.title" class="table-input" /></span>
            <span><input v-model="member.isPrimary" type="checkbox" /></span>
            <span class="row-actions"
              ><button
                class="icon-button small"
                type="button"
                title="保存成员"
                @click="updateMember(member)"
              >
                <Check :size="15" /></button
              ><button
                class="icon-button small danger"
                type="button"
                title="停用任职"
                @click="removeMember(member)"
              >
                <UserMinus :size="15" /></button
            ></span>
          </div>
          <div v-if="members.length === 0" class="empty-state">
            <UserPlus :size="24" /><strong>暂无成员</strong>
          </div>
        </div>
      </template>
      <div v-else class="empty-state"><Building2 :size="26" /><strong>选择一家公司</strong></div>
    </section>
  </div>

  <ModalDialog v-if="showCreate" title="新建公司" @close="showCreate = false">
    <form class="form-stack" @submit.prevent="createOrganization">
      <label class="field"><span>公司代码</span><input v-model="createForm.code" required /></label>
      <label class="field"><span>公司名称</span><input v-model="createForm.name" required /></label>
      <label class="field"
        ><span>上级公司</span
        ><select v-model="createForm.parentOrganizationId">
          <option value="">无</option>
          <option
            v-for="organization in organizations"
            :key="organization.id"
            :value="organization.id"
          >
            {{ organization.name }}
          </option>
        </select></label
      >
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showCreate = false">取消</button
        ><button class="primary-button" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />创建
        </button>
      </div>
    </form>
  </ModalDialog>

  <ModalDialog v-if="showInvite" title="邀请公司成员" @close="showInvite = false">
    <div v-if="invitationToken" class="invitation-result">
      <code>{{ invitationToken }}</code>
      <button class="primary-button" type="button" @click="copyInvitation">
        <ClipboardCopy :size="16" />复制邀请链接
      </button>
    </div>
    <form v-else class="form-stack" @submit.prevent="createInvitation">
      <label class="field"
        ><span>姓名</span><input v-model="inviteForm.displayName" required
      /></label>
      <label class="field"
        ><span>邮箱</span><input v-model="inviteForm.email" type="email" required
      /></label>
      <label class="field"
        ><span>登录名</span><input v-model="inviteForm.loginName" required
      /></label>
      <label class="field"
        ><span>初始角色</span
        ><select v-model="inviteForm.initialRoleCode">
          <option value="organization_member">公司成员</option>
          <option value="organization_admin">公司管理员</option>
        </select></label
      >
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showInvite = false">取消</button
        ><button class="primary-button" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />创建邀请
        </button>
      </div>
    </form>
  </ModalDialog>
</template>
