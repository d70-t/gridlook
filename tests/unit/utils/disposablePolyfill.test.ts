import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { expect, it } from "vitest";

const polyfill = readFileSync("src/utils/disposablePolyfill.ts", "utf8");
const compiled = ts.transpileModule(
  `
  const resource = { [Symbol.dispose]() { disposed = true; } };
  try {
    using value = resource;
    throw new Error("operation failed");
  } catch (error) {
    message = error.message;
  }
  `,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

it.each([undefined, Symbol.dispose])(
  "supports compiled using and preserves an existing disposal symbol (%s)",
  (dispose) => {
    // An isolated Symbol stand-in avoids changing Node's non-configurable symbol.
    const symbols = { for: Symbol.for, dispose };
    const context = { Symbol: symbols, disposed: false, message: "" };
    runInNewContext(polyfill + compiled, context);
    expect(symbols.dispose).toBe(dispose ?? Symbol.for("Symbol.dispose"));
    expect(context.disposed).toBe(true);
    expect(context.message).toBe("operation failed");
  }
);
