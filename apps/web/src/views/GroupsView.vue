<script setup lang="ts">
import { LoaderCircle, Plus, RefreshCw, Trash2, UserPlus, UsersRound } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';

import ModalDialog from '../components/ModalDialog.vue';
import { apiRequest } from '../lib/api';
import { notify, notifyError } from '../stores/notifications';

interface Group {
  id: string;
  organizationId: string | null;
  name: string;
  type: 'DEPARTMENT' | 'PROJECT' | 'CUSTOM';
  status: 'ACTIVE' | 'DISABLED';
  _count: { members: number };
}

interface GroupMember {
  userId: string;
  joinedAt: string;
  user: { loginName: string; email: string; displayName: string; status: string };
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const groups = ref<Group[]>([]);
const members = ref<GroupMember[]>([]);
const selectedId = ref<string | null>(null);
const loading = ref(true);
const loadingMembers = ref(false);
const showCreate = ref(false);
const showAddMember = ref(false);
const submitting = ref(false);
const createForm = reactive({ name: '', organizationId: '', type: 'CUSTOM' as Group['type'] });
const memberUserId = ref('');
const selected = computed(
  () => groups.value.find((group) => group.id === selectedId.value) ?? null,
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    groups.value = (await apiRequest<Page<Group>>('/api/v1/groups?limit=100')).items;
    if (selectedId.value === null || !groups.value.some((group) => group.id === selectedId.value)) {
      selectedId.value = groups.value[0]?.id ?? null;
    }
    await loadMembers();
  } catch (error) {
    notifyError(error, '群组加载失败');
  } finally {
    loading.value = false;
  }
}

async function selectGroup(id: string): Promise<void> {
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
      await apiRequest<Page<GroupMember>>(`/api/v1/groups/${selectedId.value}/members?limit=100`)
    ).items;
  } catch (error) {
    members.value = [];
    notifyError(error, '群组成员加载失败');
  } finally {
    loadingMembers.value = false;
  }
}

async function createGroup(): Promise<void> {
  submitting.value = true;
  try {
    const created = await apiRequest<Group>('/api/v1/groups', {
      method: 'POST',
      body: JSON.stringify({
        name: createForm.name,
        type: createForm.type,
        ...(createForm.organizationId ? { organizationId: createForm.organizationId } : {}),
      }),
    });
    showCreate.value = false;
    notify('success', '群组已创建');
    await load();
    await selectGroup(created.id);
  } catch (error) {
    notifyError(error, '群组创建失败');
  } finally {
    submitting.value = false;
  }
}

async function toggleGroup(group: Group): Promise<void> {
  try {
    await apiRequest(`/api/v1/groups/${group.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: group.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }),
    });
    notify('success', group.status === 'ACTIVE' ? '群组已停用' : '群组已启用');
    await load();
  } catch (error) {
    notifyError(error, '群组状态更新失败');
  }
}

async function addMember(): Promise<void> {
  if (selectedId.value === null) return;
  submitting.value = true;
  try {
    await apiRequest(`/api/v1/groups/${selectedId.value}/members/${memberUserId.value}`, {
      method: 'PUT',
    });
    showAddMember.value = false;
    memberUserId.value = '';
    notify('success', '成员已加入群组');
    await loadMembers();
  } catch (error) {
    notifyError(error, '添加成员失败');
  } finally {
    submitting.value = false;
  }
}

async function removeMember(member: GroupMember): Promise<void> {
  try {
    await apiRequest<void>(`/api/v1/groups/${selectedId.value}/members/${member.userId}`, {
      method: 'DELETE',
    });
    notify('success', '成员已移出群组');
    await loadMembers();
  } catch (error) {
    notifyError(error, '移除成员失败');
  }
}

onMounted(() => void load());
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">跨公司协作</p>
      <h1>共享群组</h1>
    </div>
    <div class="header-actions">
      <button class="icon-button" type="button" title="刷新" @click="load">
        <RefreshCw :size="18" /></button
      ><button class="primary-button" type="button" @click="showCreate = true">
        <Plus :size="17" />新建群组
      </button>
    </div>
  </header>

  <div class="master-detail">
    <section class="master-pane">
      <div v-if="loading" class="loading-state">
        <LoaderCircle class="spinning" :size="20" />加载中
      </div>
      <button
        v-for="group in groups"
        v-else
        :key="group.id"
        class="master-row"
        :class="{ selected: selectedId === group.id }"
        type="button"
        @click="selectGroup(group.id)"
      >
        <span class="row-icon"><UsersRound :size="18" /></span
        ><span
          ><strong>{{ group.name }}</strong
          ><small>{{ group.organizationId ? '公司群组' : 'Tenant 共享群组' }}</small></span
        ><span class="count-badge">{{ group._count.members }}</span>
      </button>
      <div v-if="!loading && groups.length === 0" class="empty-state">
        <UsersRound :size="25" /><strong>暂无群组</strong>
      </div>
    </section>

    <section class="detail-pane">
      <template v-if="selected">
        <header class="detail-header">
          <div>
            <h2>{{ selected.name }}</h2>
            <p>{{ selected.type }} · {{ selected._count.members }} 名成员</p>
          </div>
          <div class="header-actions">
            <button class="secondary-button" type="button" @click="showAddMember = true">
              <UserPlus :size="16" />添加成员</button
            ><button class="text-button" type="button" @click="toggleGroup(selected)">
              {{ selected.status === 'ACTIVE' ? '停用群组' : '启用群组' }}
            </button>
          </div>
        </header>
        <div v-if="loadingMembers" class="loading-state">
          <LoaderCircle class="spinning" :size="20" />加载成员
        </div>
        <div v-else class="data-table group-member-table">
          <div class="table-row table-header">
            <span>成员</span><span>账号</span><span>状态</span><span></span>
          </div>
          <div v-for="member in members" :key="member.userId" class="table-row">
            <span class="person-cell"
              ><strong>{{ member.user.displayName }}</strong
              ><small>{{ member.user.email }}</small></span
            ><span>{{ member.user.loginName }}</span
            ><span class="status-badge active">启用</span
            ><span class="row-actions"
              ><button
                class="icon-button small danger"
                type="button"
                title="移出群组"
                @click="removeMember(member)"
              >
                <Trash2 :size="15" /></button
            ></span>
          </div>
          <div v-if="members.length === 0" class="empty-state">
            <UserPlus :size="24" /><strong>暂无成员</strong>
          </div>
        </div>
      </template>
      <div v-else class="empty-state"><UsersRound :size="26" /><strong>选择一个群组</strong></div>
    </section>
  </div>

  <ModalDialog v-if="showCreate" title="新建群组" @close="showCreate = false">
    <form class="form-stack" @submit.prevent="createGroup">
      <label class="field"><span>群组名称</span><input v-model="createForm.name" required /></label>
      <label class="field"
        ><span>群组类型</span
        ><select v-model="createForm.type">
          <option value="DEPARTMENT">部门</option>
          <option value="PROJECT">项目</option>
          <option value="CUSTOM">自定义</option>
        </select></label
      >
      <label class="field"
        ><span>所属公司 ID</span><input v-model="createForm.organizationId"
      /></label>
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showCreate = false">取消</button
        ><button class="primary-button" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />创建
        </button>
      </div>
    </form>
  </ModalDialog>

  <ModalDialog v-if="showAddMember" title="添加群组成员" @close="showAddMember = false">
    <form class="form-stack" @submit.prevent="addMember">
      <label class="field"><span>用户 ID</span><input v-model="memberUserId" required /></label>
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showAddMember = false">取消</button
        ><button class="primary-button" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />添加
        </button>
      </div>
    </form>
  </ModalDialog>
</template>
