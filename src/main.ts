import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import router from "./router/index.ts";
import { vWordBreak } from "./utils/wordbreak.ts";
const app = createApp(App);
app.directive("word-break", vWordBreak);

const pinia = createPinia();

app.use(router);
app.use(pinia);
app.mount("#app");
