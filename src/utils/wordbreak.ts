export const vWordBreak = {
  mounted(el: HTMLElement) {
    const text = el.textContent ?? "";
    if (!text) {
      return;
    }
    el.innerHTML = text.replace(/([_\-\s]+)/g, "$1<wbr>");
  },
  updated(el: HTMLElement) {
    const text = el.textContent ?? "";
    if (!text) {
      return;
    }
    el.innerHTML = text.replace(/([_\-\s]+)/g, "$1<wbr>");
  },
};
