import { createRouter, createWebHistory } from 'vue-router';

import AppShell from './components/AppShell.vue';
import { authStore } from './stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/mfa',
      name: 'mfa',
      component: () => import('./views/MfaView.vue'),
      meta: { public: true },
    },
    {
      path: '/invite',
      name: 'invite',
      component: () => import('./views/InvitationView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: '/status' },
        { path: 'status', component: () => import('./views/StatusView.vue') },
        { path: 'sessions', component: () => import('./views/SessionsView.vue') },
        { path: 'organizations', component: () => import('./views/OrganizationsView.vue') },
        { path: 'groups', component: () => import('./views/GroupsView.vue') },
        { path: 'spaces', component: () => import('./views/SpacesView.vue') },
        { path: 'assets', component: () => import('./views/AssetsView.vue') },
        { path: 'permissions', component: () => import('./views/PermissionsView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/status' },
  ],
});

router.beforeEach(async (to) => {
  await authStore.bootstrap();
  if (to.name === 'mfa' && authStore.state.status !== 'mfa_required') {
    return { name: 'login' };
  }
  if (to.meta.public === true) {
    if (to.name === 'login' && authStore.state.status === 'authenticated') return '/status';
    return true;
  }
  if (authStore.state.status !== 'authenticated') {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  return true;
});

if (typeof window !== 'undefined') {
  window.addEventListener('dam:session-expired', () => {
    if (router.currentRoute.value.name !== 'login') {
      void router.replace({ name: 'login', query: { expired: '1' } });
    }
  });
}
