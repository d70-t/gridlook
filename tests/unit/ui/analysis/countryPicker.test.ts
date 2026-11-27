import { expect, it } from "vitest";
import { compile, createRenderer, nextTick, ssrContextKey } from "vue";
import { compileScript, parse } from "vue/compiler-sfc";

import CountryPicker from "@/ui/analysis/CountryPicker.vue";
import { mapCountryPicker } from "@/ui/analysis/countryPicking.ts";

// Node tests receive an SSR template. Compile the same template for the
// custom renderer, using the script-setup bindings from the component.
const { default: source } = await import("@/ui/analysis/CountryPicker.vue?raw");
const { descriptor } = parse(source);
const render = compile(descriptor.template!.content, {
  prefixIdentifiers: true,
  bindingMetadata: compileScript(descriptor, { id: "CountryPicker" }).bindings,
});

// The project's tests run in Node. This small Vue renderer exercises this
// form's real v-model/select and submit handlers with native change events.
class TNode extends EventTarget {
  readonly children: TNode[] = [];
  parent?: TNode;
  selectedIndex = -1;
  value = "";
  readonly attrs: Record<string, unknown> = {};
  constructor(readonly tag: string) {
    super();
  }
  get options() {
    return this.children.filter((child) => child.tag === "option");
  }
  get selected(): boolean {
    return this.parent?.options[this.parent.selectedIndex] === this;
  }
  focus() {}
  remove() {
    if (this.parent) {
      const siblings = this.parent.children;
      siblings.splice(siblings.indexOf(this), 1);
    }
  }
}

function formRenderer(elements: TNode[]) {
  return createRenderer<TNode, TNode>({
    createElement(tag) {
      const element = new TNode(tag);
      elements.push(element);
      return element;
    },
    createText: () => new TNode("text"),
    createComment: () => new TNode("comment"),
    setText() {},
    setElementText() {},
    remove: (node) => node.remove(),
    parentNode: (node) => node.parent ?? null,
    nextSibling: (node) =>
      node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, before) {
      node.remove();
      node.parent = parent;
      if (before) {
        parent.children.splice(parent.children.indexOf(before), 0, node);
      } else {
        parent.children.push(node);
      }
    },
    patchProp(node, key, previous, next) {
      if (key === "value") {
        node.value = next;
      } else if (/^on[A-Z]/.test(key)) {
        const type = key.slice(2).toLowerCase();
        if (previous) {
          node.removeEventListener(type, previous);
        }
        if (next) {
          node.addEventListener(type, next);
        }
      } else {
        node.attrs[key] = next;
      }
    },
  });
}
function mountPicker(
  onSelect: (value: unknown) => void,
  more: Record<string, unknown> = {}
) {
  const elements: TNode[] = [];
  const app = formRenderer(elements).createApp(
    { ...CountryPicker, render },
    {
      submitLabel: "Create plot",
      onSelect,
      ...more,
    }
  );
  app.provide(ssrContextKey, {});
  app.mount(new TNode("root"));
  const [scale] = elements.filter((node) => node.tag === "select");
  return {
    app,
    scale,
    search: elements.find((node) => node.tag === "input")!,
    // The listbox's options, as rendered now.
    options: () =>
      elements.filter(
        (node) =>
          node.tag === "li" && node.parent && node.attrs.role === "option"
      ),
    form: elements.find((node) => node.tag === "form")!,
    // A button by its data-action, as rendered now.
    action: (name: string) =>
      elements.find(
        (node) =>
          node.tag === "button" &&
          node.parent &&
          node.attrs["data-action"] === name
      ),
  };
}

async function choose(select: TNode, value: string) {
  select.selectedIndex = select.options.findIndex(
    (node) => node.value === value
  );
  expect(select.selectedIndex).toBeGreaterThanOrEqual(0);
  select.dispatchEvent(new Event("change"));
  await nextTick();
  await nextTick();
}

async function type(search: TNode, text: string) {
  search.value = text;
  search.dispatchEvent(new Event("input"));
  await nextTick();
}

function key(search: TNode, name: string) {
  search.dispatchEvent(Object.assign(new Event("keydown"), { key: name }));
}

it("opens at standard detail and submits the ID and chosen scale for a fine-only territory", async () => {
  const submitted: unknown[] = [];
  const { app, scale, search, options, form } = mountPicker((value) =>
    submitted.push(value)
  );
  await nextTick();
  expect(scale.options[scale.selectedIndex].value).toBe("50m");
  await type(search, "akrotiri");
  expect(options()).toHaveLength(0);
  await choose(scale, "10m");
  await type(search, "akrotiri");
  expect(options().length).toBeGreaterThan(0);
  key(search, "Enter");
  await nextTick();
  form.dispatchEvent(new Event("submit"));
  expect(submitted).toEqual([
    { kind: "country", id: "ne-akrotiri", resolution: "10m" },
  ]);
  await choose(scale, "110m");
  form.dispatchEvent(new Event("submit"));
  expect(submitted).toHaveLength(1);
  app.unmount();
});

it("finds a country by part of its name, accents and case ignored", async () => {
  const submitted: unknown[] = [];
  const { app, search, options, form } = mountPicker((value) =>
    submitted.push(value)
  );
  await nextTick();
  await nextTick();
  await type(search, "COTE D");
  expect(options().length).toBeGreaterThan(0);
  key(search, "Enter");
  await nextTick();
  form.dispatchEvent(new Event("submit"));
  expect(submitted).toHaveLength(1);
  // ISO 3166 numeric: Côte d’Ivoire.
  expect((submitted[0] as { id: string }).id).toBe("384");
  // Over the name shown once the list closes, typing replaces the choice.
  search.dispatchEvent(new Event("blur"));
  await nextTick();
  expect(search.value).toBe("Côte d'Ivoire");
  await type(search, "Fra");
  form.dispatchEvent(new Event("submit"));
  expect(submitted).toHaveLength(1);
  app.unmount();
});

it("v30: several countries, by Add a country and by Ctrl/⌘ on the map", async () => {
  const submitted: unknown[] = [];
  const { app, search, form, action } = mountPicker((value) =>
    submitted.push(value)
  );
  await nextTick();
  await nextTick();
  await type(search, "France");
  key(search, "Enter");
  await nextTick();
  action("add-country")!.dispatchEvent(new Event("click"));
  await nextTick();
  await type(search, "Germany");
  key(search, "Enter");
  await nextTick();
  // Ctrl/⌘-click on the map adds Poland (616); again takes it out.
  const picker = mapCountryPicker.value!;
  picker.choose({ kind: "country", id: "616", resolution: "50m" }, true);
  await nextTick();
  form.dispatchEvent(new Event("submit"));
  // Sorted ids: Germany 276, France 250, Poland 616 (ISO numeric).
  expect(submitted.at(-1)).toEqual({
    kind: "country",
    id: "250",
    resolution: "50m",
    ids: ["250", "276", "616"],
  });
  picker.choose({ kind: "country", id: "616", resolution: "50m" }, true);
  await nextTick();
  form.dispatchEvent(new Event("submit"));
  expect(submitted.at(-1)).toEqual({
    kind: "country",
    id: "250",
    resolution: "50m",
    ids: ["250", "276"],
  });
  // A plain click starts over with one country.
  picker.choose({ kind: "country", id: "616", resolution: "50m" });
  await nextTick();
  form.dispatchEvent(new Event("submit"));
  expect(submitted.at(-1)).toEqual({
    kind: "country",
    id: "616",
    resolution: "50m",
  });
  app.unmount();
});

it("v30: a new plot's picker offers importing a shape instead", async () => {
  const imports: unknown[] = [];
  const { app, action } = mountPicker(() => undefined, {
    offerShapes: true,
    onImportShape: () => imports.push(true),
  });
  await nextTick();
  action("import-shape")!.dispatchEvent(new Event("click"));
  expect(imports).toHaveLength(1);
  app.unmount();
  // Settings' picker does not.
  const plain = mountPicker(() => undefined);
  await nextTick();
  expect(plain.action("import-shape")).toBeUndefined();
  plain.app.unmount();
});

it("25 Nov: the list ticks several countries and stays open", async () => {
  const submitted: unknown[] = [];
  const { app, search, options, form } = mountPicker((value) =>
    submitted.push(value)
  );
  await nextTick();
  await nextTick();
  search.dispatchEvent(new Event("click"));
  await nextTick();
  const row = (name: string) =>
    options().find((node) => node.attrs.id === `country-${name}`)!;
  const press = async (id: string) => {
    row(id).dispatchEvent(new Event("mousedown"));
    await nextTick();
  };
  // France (250), Germany (276), Poland (616): ticked, the list still open.
  await press("250");
  await press("276");
  await press("616");
  expect(options().length).toBeGreaterThan(3);
  expect(
    options()
      .filter((node) => node.attrs["aria-selected"])
      .map((node) => node.attrs.id)
  ).toEqual(["country-250", "country-276", "country-616"]);
  // Ticked again: Germany is taken out.
  await press("276");
  // A search finds one more and Enter ticks it; the others stay.
  await type(search, "Ital");
  key(search, "Enter");
  await nextTick();
  form.dispatchEvent(new Event("submit"));
  expect(submitted.at(-1)).toEqual({
    kind: "country",
    id: "250",
    resolution: "50m",
    ids: ["250", "380", "616"],
  });
  app.unmount();
});
