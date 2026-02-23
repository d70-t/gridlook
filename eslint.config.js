import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import importPlugin from "eslint-plugin-import";
import prettier from "eslint-plugin-prettier/recommended";
import pluginPromise from "eslint-plugin-promise";
import vue from "eslint-plugin-vue";
import globals from "globals";
import ts from "typescript-eslint";

export default [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    ignores: ["src/components/js/*.js", "node_modules", "dist"],
  },

  // js
  js.configs.recommended,
  {
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
      camelcase: "warn",
      eqeqeq: "error",
      strict: "error",
      "max-lines-per-function": [
        "warn",
        { max: 50, skipComments: true, skipBlankLines: true },
      ],
      "no-confusing-arrow": ["error", { allowParens: false }],
    },
  },
  importPlugin.flatConfigs.recommended,
  {
    rules: {
      "import/no-unresolved": "off",
      "import/named": "off",
      "import/namespace": "off",
      "import/default": "off",
      "import/no-named-as-default-member": "off",
      "import/order": [
        "warn",
        {
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
    },
  },

  pluginPromise.configs["flat/recommended"],

  // ts
  ...ts.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // vue
  ...vue.configs["flat/recommended"],
  {
    files: ["*.vue", "**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
      },
    },
  },
  {
    rules: {
      "vue/multi-word-component-names": "off",
      "vue/no-v-html": "off",

      "vue/block-lang": ["error", { script: { lang: "ts" } }],
      "vue/block-order": [
        "error",
        {
          order: [["script", "template"], "style"],
        },
      ],
      "vue/component-api-style": ["error", ["script-setup"]],
      "vue/component-name-in-template-casing": "error",
      "vue/custom-event-name-casing": "error",
      "vue/define-emits-declaration": "error",
      "vue/define-macros-order": [
        "error",
        {
          order: [
            "defineOptions",
            "defineModel",
            "defineProps",
            "defineEmits",
            "defineSlots",
          ],
          defineExposeLast: true,
        },
      ],

      "vue/define-props-declaration": "error",
      "vue/html-button-has-type": "error",
      "vue/no-multiple-objects-in-class": "warn",
      "vue/no-root-v-if": "error",
      "vue/no-template-target-blank": "error",
      "vue/no-undef-components": "warn",
      "vue/no-dupe-keys": "error",
      "vue/no-reserved-keys": "error",
      "vue/no-shared-component-data": "error",
      "vue/require-valid-default-prop": "error",
      "vue/require-default-prop": "error",
      "vue/require-prop-types": "error",
      "vue/this-in-template": "error",
      "vue/no-undef-properties": "warn",
      "vue/no-unused-refs": "warn",
      "vue/no-use-v-else-with-v-for": "error",
      "vue/no-useless-mustaches": "warn",
      "vue/no-useless-v-bind": "warn",
      "vue/no-v-text": "error",
      "vue/padding-line-between-blocks": "warn",
      "vue/prefer-define-options": "error",
      "vue/prefer-separate-static-class": "warn",
      "vue/prefer-true-attribute-shorthand": "warn",
      "vue/require-macro-variable-name": "error",
      "vue/require-typed-ref": "warn",
      "vue/v-for-delimiter-style": "error",
      "vue/valid-define-options": "error",
    },
  },
  prettier,
  {
    rules: {
      "prettier/prettier": "warn",
    },
  },
  // prettier disables style rules, re-enable curly
  {
    rules: {
      curly: "warn",
    },
  },
  {
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "assets", pattern: "src/assets/**" },
        { type: "lib", pattern: "src/lib/**" },
        { type: "store", pattern: "src/store/**" },
        { type: "ui", pattern: "src/ui/**" },
        { type: "views", pattern: "src/views/**" },
        { type: "types", pattern: "src/types/**" },
        { type: "utils", pattern: "src/utils/**" },
        { type: "router", pattern: "src/router/**" },
        { type: "src", pattern: "src/*", mode: "file" },
      ],
      "boundaries/ignore": [
        "**/*.spec.ts",
        "**/*.test.ts",
        "env.d.ts",
        "vite.config.ts",
        "eslint.config.js",
      ],
      "import/resolver": {
        typescript: true,
      },
    },
    rules: {
      ...boundaries.configs.recommended.rules,
      "boundaries/no-unknown-files": "warn",
      "boundaries/no-unknown": "warn",
      "boundaries/element-types": [
        2,
        {
          default: "disallow",
          rules: [
            { from: "ui", allow: ["store", "lib", "ui", "utils"] },
            { from: "store", allow: ["lib", "utils"] },
            { from: "lib", allow: ["assets", "utils"] },
            { from: "views", allow: ["lib", "store", "ui", "utils"] },
            { from: "src", allow: ["lib", "src", "router", "views"] },
            { from: "router", allow: ["views"] },
            { from: "utils", disallow: ["*"] },
          ],
        },
      ],
    },
  },
];
