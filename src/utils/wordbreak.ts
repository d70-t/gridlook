export const vWordBreak = {
  mounted(el: HTMLElement) {
    el.innerHTML = el.textContent.replace(/([_\-\s]+)/g, "$1<wbr>");
  },
  updated(el: HTMLElement) {
    el.innerHTML = el.textContent.replace(/([_\-\s]+)/g, "$1<wbr>");
  },
};
