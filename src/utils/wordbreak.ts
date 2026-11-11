// The text is dataset metadata (a variable's long_name), so it is rebuilt as
// text nodes and <wbr> elements, never parsed as HTML.
function breakWords(el: HTMLElement) {
  const text = el.textContent ?? "";
  if (!text) {
    return;
  }
  const parts = text.split(/(?<=[_\-\s])(?![_\-\s])/);
  el.replaceChildren(
    ...parts.flatMap((part, i) =>
      i ? [document.createElement("wbr"), part] : [part]
    )
  );
}

export const vWordBreak = {
  mounted: breakWords,
  updated: breakWords,
};
