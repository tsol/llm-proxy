import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import QueueView from './views/QueueView.vue';
import ResourcesView from './views/ResourcesView.vue';
import ServicesView from './views/ServicesView.vue';
import ServiceView from './views/ServiceView.vue';

const router = createRouter({
  history: createWebHistory('/ui/'),
  routes: [
    { path: '/', component: QueueView },
    { path: '/resources', component: ResourcesView },
    { path: '/services', component: ServicesView },
    { path: '/services/:id', component: ServiceView },
  ],
});

createApp(App).use(router).mount('#app');
