/* eslint-env node */
module.exports = {
  root: true,
  extends: [
    "plugin:vue/vue3-essential",
    "plugin:promise/recommended",
    "eslint:recommended",
    "@vue/eslint-config-typescript/recommended",
    "@vue/eslint-config-prettier",
  ],
  rules: {
    "vue/multi-word-component-names": ["error", { ignores: ["Globe"] }],
  },
  env: {
    "vue/setup-compiler-macros": true,
  },
};
