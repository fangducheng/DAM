<script setup lang="ts">
import { FolderKanban, LoaderCircle, Plus, RefreshCw, Trash2, UserPlus } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';

import ModalDialog from '../components/ModalDialog.vue';
import { apiRequest } from '../lib/api';
import { notify, notifyError } from '../stores/notifications';

type PrincipalType = 'USER' | 'GROUP' | 'ORGANIZATION';
type SpaceRole = 'space_manager' | 'editor' | 'contributor' | 'viewer' | 'restricted';

interface Space {
  id: string;
  code: string;
  name: string;
  ownerType: 'TENANT' | 'ORGANIZATION';
  ownerOrganizationId: string | null;
  quotaBytes: string;
  usedBytes: string;
  status: 'ACTIVE' | 'DISABLED';
  ownerOrganization: { code: string; name: string } | null;
  _count: { members: number; nodes: number };
}
interface SpaceMember {
  principalType: PrincipalType;
  principalId: string;
  createdAt: string;
  role: { code: SpaceRole; name: string };
  principal: { name: string; status: string } | null;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const spaces = ref<Space[]>([]);
const members = ref<SpaceMember[]>([]);
const selectedId = ref<string | null>(null);
const loading = ref(true);
const loadingMembers = ref(false);
const showCreate = ref(false);
const showMember = ref(false);
const submitting = ref(false);
const createForm = reactive({
  code: '',
  name: '',
  ownerType: 'TENANT' as Space['ownerType'],
  ownerOrganizationId: '',
  quotaGb: '10',
});
const memberForm = reactive({
  principalType: 'USER' as PrincipalType,
  principalId: '',
  roleCode: 'viewer' as SpaceRole,
});
const selected = computed(
  () => spaces.value.find((space) => space.id === selectedId.value) ?? null,
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    spaces.value = (await apiRequest<Page<Space>>('/api/v1/spaces?limit=100')).items;
    if (selectedId.value === null || !spaces.value.some((space) => space.id === selectedId.value))
      selectedId.value = spaces.value[0]?.id ?? null;
    await loadMembers();
  } catch (error) {
    notifyError(error, '空间加载失败');
  } finally {
    loading.value = false;
  }
}

async function selectSpace(id: string): Promise<void> {
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
      await apiRequest<Page<SpaceMember>>(`/api/v1/spaces/${selectedId.value}/members?limit=100`)
    ).items;
  } catch (error) {
    members.value = [];
    notifyError(error, '空间成员加载失败');
  } finally {
    loadingMembers.value = false;
  }
}

async function createSpace(): Promise<void> {
  submitting.value = true;
  try {
    const quotaBytes = (
      BigInt(Math.max(0, Number(createForm.quotaGb))) *
      1024n *
      1024n *
      1024n
    ).toString();
    const created = await apiRequest<Space>('/api/v1/spaces', {
      method: 'POST',
      body: JSON.stringify({
        code: createForm.code,
        name: createForm.name,
        ownerType: createForm.ownerType,
        quotaBytes,
        ...(createForm.ownerType === 'ORGANIZATION'
          ? { ownerOrganizationId: createForm.ownerOrganizationId }
          : {}),
      }),
    });
    showCreate.value = false;
    notify('success', '空间已创建');
    await load();
    await selectSpace(created.id);
  } catch (error) {
    notifyError(error, '空间创建失败');
  } finally {
    submitting.value = false;
  }
}

async function upsertMember(): Promise<void> {
  if (selectedId.value === null) return;
  submitting.value = true;
  try {
    await apiRequest(
      `/api/v1/spaces/${selectedId.value}/members/${memberForm.principalType}/${memberForm.principalId}`,
      { method: 'PUT', body: JSON.stringify({ roleCode: memberForm.roleCode }) },
    );
    showMember.value = false;
    notify('success', '空间成员已更新');
    await loadMembers();
  } catch (error) {
    notifyError(error, '空间成员更新失败');
  } finally {
    submitting.value = false;
  }
}

async function removeMember(member: SpaceMember): Promise<void> {
  try {
    await apiRequest<void>(
      `/api/v1/spaces/${selectedId.value}/members/${member.principalType}/${member.principalId}`,
      { method: 'DELETE' },
    );
    notify('success', '空间成员已移除');
    await loadMembers();
  } catch (error) {
    notifyError(error, '空间成员移除失败');
  }
}

async function toggleSpace(space: Space): Promise<void> {
  try {
    await apiRequest(`/api/v1/spaces/${space.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: space.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }),
    });
    notify('success', space.status === 'ACTIVE' ? '空间已停用' : '空间已启用');
    await load();
  } catch (error) {
    notifyError(error, '空间状态更新失败');
  }
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (bytes === 0) return '不限';
  return `${(bytes / 1024 / 1024 / 1024).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

const roleLabels: Record<SpaceRole, string> = {
  space_manager: '空间管理员',
  editor: '编辑者',
  contributor: '贡献者',
  viewer: '查看者',
  restricted: '受限成员',
};
const principalLabels: Record<PrincipalType, string> = {
  USER: '用户',
  GROUP: '群组',
  ORGANIZATION: '公司',
};
onMounted(() => void load());
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">资料边界</p>
      <h1>业务空间</h1>
    </div>
    <div class="header-actions">
      <button class="icon-button" type="button" title="刷新" @click="load">
        <RefreshCw :size="18" /></button
      ><button class="primary-button" type="button" @click="showCreate = true">
        <Plus :size="17" />新建空间
      </button>
    </div>
  </header>
  <div class="master-detail">
    <section class="master-pane">
      <div v-if="loading" class="loading-state">
        <LoaderCircle class="spinning" :size="20" />加载中
      </div>
      <button
        v-for="space in spaces"
        v-else
        :key="space.id"
        class="master-row"
        :class="{ selected: selectedId === space.id }"
        type="button"
        @click="selectSpace(space.id)"
      >
        <span class="row-icon"><FolderKanban :size="18" /></span
        ><span
          ><strong>{{ space.name }}</strong
          ><small>{{ space.ownerOrganization?.name ?? '集团共享' }}</small></span
        ><span class="count-badge">{{ space._count.members }}</span>
      </button>
      <div v-if="!loading && spaces.length === 0" class="empty-state">
        <FolderKanban :size="25" /><strong>暂无空间</strong>
      </div>
    </section>
    <section class="detail-pane">
      <template v-if="selected">
        <header class="detail-header">
          <div>
            <h2>{{ selected.name }}</h2>
            <p>
              {{ selected.code }} · {{ formatBytes(selected.usedBytes) }} /
              {{ formatBytes(selected.quotaBytes) }} · {{ selected._count.nodes }} 个节点
            </p>
          </div>
          <div class="header-actions">
            <button class="secondary-button" type="button" @click="showMember = true">
              <UserPlus :size="16" />添加主体</button
            ><button class="text-button" type="button" @click="toggleSpace(selected)">
              {{ selected.status === 'ACTIVE' ? '停用空间' : '启用空间' }}
            </button>
          </div>
        </header>
        <div v-if="loadingMembers" class="loading-state">
          <LoaderCircle class="spinning" :size="20" />加载成员
        </div>
        <div v-else class="data-table space-member-table">
          <div class="table-row table-header">
            <span>主体</span><span>类型</span><span>空间角色</span><span>状态</span><span></span>
          </div>
          <div
            v-for="member in members"
            :key="`${member.principalType}:${member.principalId}`"
            class="table-row"
          >
            <span class="person-cell"
              ><strong>{{ member.principal?.name ?? member.principalId }}</strong
              ><small>{{ member.principalId }}</small></span
            ><span>{{ principalLabels[member.principalType] }}</span
            ><span>{{ roleLabels[member.role.code] }}</span
            ><span class="status-badge active">{{
              member.principal?.status === 'ACTIVE' ? '启用' : (member.principal?.status ?? '启用')
            }}</span
            ><span class="row-actions"
              ><button
                class="icon-button small danger"
                type="button"
                title="移除空间成员"
                @click="removeMember(member)"
              >
                <Trash2 :size="15" /></button
            ></span>
          </div>
          <div v-if="members.length === 0" class="empty-state">
            <UserPlus :size="24" /><strong>暂无空间成员</strong>
          </div>
        </div>
      </template>
      <div v-else class="empty-state"><FolderKanban :size="26" /><strong>选择一个空间</strong></div>
    </section>
  </div>

  <ModalDialog v-if="showCreate" title="新建空间" @close="showCreate = false"
    ><form class="form-stack" @submit.prevent="createSpace">
      <label class="field"><span>空间代码</span><input v-model="createForm.code" required /></label
      ><label class="field"><span>空间名称</span><input v-model="createForm.name" required /></label
      ><label class="field"
        ><span>所有权</span
        ><select v-model="createForm.ownerType">
          <option value="TENANT">集团共享</option>
          <option value="ORGANIZATION">公司私有</option>
        </select></label
      ><label v-if="createForm.ownerType === 'ORGANIZATION'" class="field"
        ><span>所属公司 ID</span><input v-model="createForm.ownerOrganizationId" required /></label
      ><label class="field"
        ><span>配额（GB）</span><input v-model="createForm.quotaGb" type="number" min="0"
      /></label>
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showCreate = false">取消</button
        ><button class="primary-button" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />创建
        </button>
      </div>
    </form></ModalDialog
  >
  <ModalDialog v-if="showMember" title="添加空间主体" @close="showMember = false"
    ><form class="form-stack" @submit.prevent="upsertMember">
      <label class="field"
        ><span>主体类型</span
        ><select v-model="memberForm.principalType">
          <option value="USER">用户</option>
          <option value="GROUP">群组</option>
          <option value="ORGANIZATION">公司</option>
        </select></label
      ><label class="field"
        ><span>主体 ID</span><input v-model="memberForm.principalId" required /></label
      ><label class="field"
        ><span>空间角色</span
        ><select v-model="memberForm.roleCode">
          <option v-for="(label, code) in roleLabels" :key="code" :value="code">{{ label }}</option>
        </select></label
      >
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showMember = false">取消</button
        ><button class="primary-button" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />保存
        </button>
      </div>
    </form></ModalDialog
  >
</template>
