export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "ui", // user-facing: controls, overlays, views, shared components
        "lib", // core behavior: rendering, projections, grid logic, data handling
        "config", // project setup: Vite, ESLint, TypeScript, scripts, CI
        "deps", // dependency-only updates in package.json / lockfile
        "docs", // README and docs/
        "assets", // static files: logos, screenshots, example data, colormaps, geojson
      ],
    ],
    "scope-empty": [0, "never"],
    "scope-case": [2, "always", "lower-case"],
    "type-enum": [
      2,
      "always",
      [
        "feat", // new user-facing feature
        "fix", // bug fix
        "refactor", // internal restructure, no behavior change
        "test", // adding or updating tests
        "chore", // maintenance, tooling
        "style", // formatting, no logic change
        "docs", // documentation only
      ],
    ],
    "type-case": [2, "always", "lower-case"],
    "subject-case": [2, "never", ["start-case", "pascal-case", "upper-case"]],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 100],
    "body-leading-blank": [1, "always"],
    "footer-leading-blank": [1, "always"],
  },
};
