import Aura from "@primevue/themes/aura";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";
import { createApp } from "vue";

import App from "./App.vue";
import router from "./router";
const app = createApp(App);
const pinia = createPinia();

app.use(router);
app.use(pinia);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
  },
});
app.use(ToastService);
app.mount("#app");
