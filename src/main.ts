import { definePreset } from "@primevue/themes";
import Aura from "@primevue/themes/aura";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";
import { createApp } from "vue";

import App from "./App.vue";
import router from "./router";
const app = createApp(App);
const pinia = createPinia();

const MyPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: "var(--bulma-info-95)",
      100: "var(--bulma-info-90)",
      200: "var(--bulma-info-80)",
      300: "var(--bulma-info-70)",
      400: "var(--bulma-info-60)",
      500: "var(--bulma-info-50)",
      600: "var(--bulma-info-40)",
      700: "var(--bulma-info-30)",
      800: "var(--bulma-info-20)",
      900: "var(--bulma-info-10)",
      950: "var(--bulma-info-05)",
    },
  },
  components: {
    select: {},
  },
});

app.use(router);
app.use(pinia);
app.use(PrimeVue, {
  theme: {
    preset: MyPreset,
  },
});
app.use(ToastService);
app.mount("#app");
