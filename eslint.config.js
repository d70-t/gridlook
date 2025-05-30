import globals from "globals";
import js from "@eslint/js";
import ts from "typescript-eslint";
import vue from "eslint-plugin-vue";
import pluginPromise from "eslint-plugin-promise";
import prettier from "eslint-plugin-prettier/recommended";

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
      "no-confusing-arrow": ["error", { allowParens: false }],
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

  // prettier
  prettier,
  {
    rules: {
      "prettier/prettier": "warn",
    },
  },
];
