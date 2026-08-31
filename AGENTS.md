**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- If the request is complicated, check if a thirdparty library could do the job. Ask before adding it to the project.
- Does this need to be built at all? (YAGNI)
- Does the standard library already do this? Use it.
- Does a native platform feature cover it? Use it.
- Does an already-installed dependency solve it? Use it.
- Can this be one line? Make it one line.
- Only then: write the minimum code that works.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No boilerplate nobody asked for.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Introduce as little code as possible.
- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.
- Mark intentional simplifications with a ponytail: comment. If the shortcut has a known ceiling (global lock, O(n²) scan, naive heuristic), the comment names the ceiling and the upgrade path.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

Not lazy about: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. After Implementation

- Never start a development server!
- Check for types
- Execute the linter and correct all issues concerning the code you touched. If there were issues before-hand, dont touch them

## Conventions

- If I ask you to implement a codec, never implement the encode-function and leave it empty, we don't need the code
- Types have to start with `T`. E.g. a Type FooBar is should be named TFooBar
- If we have a need for debouncers, use VueUse's `useDebounceFn` (imperative) or `watchDebounced` (reactive watcher). Do not implement your own.
- Use axios if we need to fetch remote data.
- Introduce as little CSS as possible. Keep the style consistent and use as much Bulma-CSS as possible. If a CSS-rule has to be used on several occasions, put it into `src/assets.scss`
- ignore all files which have a " copy" as part of their name. They only exist as a temporary backup of an idea and are not meant to be considered to be active code
- Be very hesitant about introducing vue-watchers as they are very prone to race conditions. If you introduce a watcher, be sure that there is only one watcher per variable
- Never use Math.max or Math.min if you don't know it advance how many values there are as arguments. Prefer loops for this.
- Create const-objects for closed-vocabulary strings and derive types. E.g. instead of a string-type `"top" | "bottom"`, create

```
export const Direction = {
  "TOP": "top",
  "BOTTOM": bottom
} as const;

export type TDirection = (typeof Direction)[keyof typeof Direction];
```

Apply the same principle for numbers
