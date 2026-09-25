/**
 * Which viewer tab a command should reuse, kept free of JupyterLab imports so
 * it can be unit-tested on its own.
 *
 * Tabs are keyed by the raw contents path, so distinct paths never collide
 * (`a b.zarr` vs `a-b.zarr`); widget ids are unique per tab and carry no path.
 * The launcher (no path) always opens a fresh tab.
 */

/** The slice of a Lumino widget the registry needs. */
export interface ViewerTab {
  readonly isDisposed: boolean;
  /** False once the widget left the DOM (a closed tab that was not disposed). */
  readonly isAttached?: boolean;
}

export class ViewerTabs<T extends ViewerTab> {
  private readonly byPath = new Map<string, T>();

  /** The live tab already showing `path`, if any. */
  find(path?: string): T | undefined {
    if (!path) {
      return undefined;
    }
    const tab = this.byPath.get(path);
    if (tab && (tab.isDisposed || tab.isAttached === false)) {
      this.byPath.delete(path);
      return undefined;
    }
    return tab;
  }

  /** Remember `tab` as the one showing `path` (a no-op for the launcher). */
  add(path: string | undefined, tab: T): void {
    if (path) {
      this.byPath.set(path, tab);
    }
  }

  /** Forget `tab` (call on dispose); a newer tab for the same path is kept. */
  remove(path: string | undefined, tab: T): void {
    if (path && this.byPath.get(path) === tab) {
      this.byPath.delete(path);
    }
  }
}
