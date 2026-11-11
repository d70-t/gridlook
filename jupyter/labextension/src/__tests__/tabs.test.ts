import { ViewerTabs } from "../tabs";

const tab = () => ({ isDisposed: false });

describe("ViewerTabs", () => {
  it("reuses the live tab for the same path", () => {
    const tabs = new ViewerTabs();
    const t = tab();
    tabs.add("data/a.zarr", t);
    expect(tabs.find("data/a.zarr")).toBe(t);
  });

  it("keeps paths that differ only in punctuation apart", () => {
    const tabs = new ViewerTabs();
    const [spaced, dashed, dotted] = [tab(), tab(), tab()];
    tabs.add("a b.zarr", spaced);
    tabs.add("a-b.zarr", dashed);
    tabs.add("a.b.zarr", dotted);
    expect(tabs.find("a b.zarr")).toBe(spaced);
    expect(tabs.find("a-b.zarr")).toBe(dashed);
    expect(tabs.find("a.b.zarr")).toBe(dotted);
  });

  it("never reuses a tab for the launcher (no path)", () => {
    const tabs = new ViewerTabs();
    tabs.add(undefined, tab());
    tabs.add("", tab());
    expect(tabs.find(undefined)).toBeUndefined();
    expect(tabs.find("")).toBeUndefined();
  });

  it("drops a disposed tab", () => {
    const tabs = new ViewerTabs<{ isDisposed: boolean }>();
    const t = tab();
    tabs.add("a.zarr", t);
    t.isDisposed = true;
    expect(tabs.find("a.zarr")).toBeUndefined();
  });

  it("drops a tab that left the DOM without being disposed", () => {
    // Lumino's default close request unparents but does not dispose; a
    // detached tab cannot be activated, so it must not be reused.
    const tabs = new ViewerTabs<{ isDisposed: boolean; isAttached: boolean }>();
    const t = { isDisposed: false, isAttached: true };
    tabs.add("a.zarr", t);
    expect(tabs.find("a.zarr")).toBe(t);
    t.isAttached = false;
    expect(tabs.find("a.zarr")).toBeUndefined();
  });

  it("removes only the tab it is given", () => {
    const tabs = new ViewerTabs();
    const [old, current] = [tab(), tab()];
    tabs.add("a.zarr", old);
    tabs.add("a.zarr", current);
    tabs.remove("a.zarr", old);
    expect(tabs.find("a.zarr")).toBe(current);
    tabs.remove("a.zarr", current);
    expect(tabs.find("a.zarr")).toBeUndefined();
  });
});
