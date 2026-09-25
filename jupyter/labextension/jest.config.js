/** Unit tests for the pure helpers only (no JupyterLab runtime needed). */
module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      { tsconfig: { module: "commonjs", composite: false, types: ["jest"] } },
    ],
  },
};
