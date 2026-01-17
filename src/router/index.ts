import { createRouter, createWebHistory } from "vue-router";

import HashGlobeView from "../views/HashGlobeView.vue";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/",
      name: "home",
      component: HashGlobeView,
    },
  ],
});

export default router;
