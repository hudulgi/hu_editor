// How the panes share the room: a tree of columns and rows with the panes as its
// leaves, each named by its key. Plain data, never changed in place.

export type Direction = "columns" | "rows";
export type Side = "left" | "right" | "top" | "bottom";

/** Leaves, or two or more children whose shares add up to 1; a split inside a split goes the other way. */
export type Tree<Leaf> = Leaf | Branch<Leaf>;

interface Branch<Leaf> {
  direction: Direction;
  children: { node: Tree<Leaf>; share: number }[];
}

export type LayoutNode = Tree<{ pane: number }>;

type Split = Branch<{ pane: number }>;

/** A part of the room, as fractions of it. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The border between two children of a split, to resize them by. */
export interface Sash extends Box {
  id: string;
  direction: Direction;
  /** Child indexes from the root to the split. */
  path: number[];
  /** The child after the border. */
  index: number;
  /** The split's own box. */
  parent: Box;
}

export type Preset = "single" | "twoColumns" | "threeColumns" | "twoRows" | "threeRows" | "grid" | "twoRowsRight" | "twoColumnsBottom";

/** A pane may get no smaller than this part of its split, unless the two around the sash have less to share. */
const MIN_SHARE = 0.15;

const isPane = (node: LayoutNode): node is { pane: number } => "pane" in node;

/** The panes in reading order. */
export function leaves(node: LayoutNode): number[] {
  return isPane(node) ? [node.pane] : node.children.flatMap((child) => leaves(child.node));
}

/** Back to what a split promises, after a child went or a split landed in one going the same way. */
function tidy(node: LayoutNode): LayoutNode {
  if (isPane(node)) return node;
  const children = node.children.flatMap(({ node: child, share }) => {
    const tidied = tidy(child);
    if (isPane(tidied) || tidied.direction !== node.direction) return [{ node: tidied, share }];
    return tidied.children.map((inner) => ({ node: inner.node, share: inner.share * share }));
  });
  if (children.length === 1) return children[0].node;
  const total = children.reduce((sum, child) => sum + child.share, 0);
  return { direction: node.direction, children: children.map((child) => ({ node: child.node, share: child.share / total })) };
}

export const directionOf = (side: Side): Direction => (side === "left" || side === "right" ? "columns" : "rows");

/** A new pane on `side` of the pane `key`, each taking half of what that one had. */
export function splitAt(root: LayoutNode, key: number, added: number, side: Side): LayoutNode {
  const pair = side === "left" || side === "top" ? [added, key] : [key, added];
  const visit = (node: LayoutNode): LayoutNode => {
    if (isPane(node)) {
      if (node.pane !== key) return node;
      return { direction: directionOf(side), children: pair.map((pane) => ({ node: { pane }, share: 0.5 })) };
    }
    return { direction: node.direction, children: node.children.map((child) => ({ node: visit(child.node), share: child.share })) };
  };
  return tidy(visit(root));
}

/** The pane `key` gone, those next to it sharing its room. The last pane stays. */
export function without(root: LayoutNode, key: number): LayoutNode {
  const visit = (node: LayoutNode): LayoutNode | null => {
    if (isPane(node)) return node.pane === key ? null : node;
    const children = node.children.flatMap((child) => {
      const kept = visit(child.node);
      return kept ? [{ node: kept, share: child.share }] : [];
    });
    return { direction: node.direction, children };
  };
  return tidy(visit(root) ?? root);
}

/** Columns become rows and rows columns; the sizes stay. */
export function flipped(node: LayoutNode): LayoutNode {
  if (isPane(node)) return node;
  return {
    direction: node.direction === "columns" ? "rows" : "columns",
    children: node.children.map((child) => ({ node: flipped(child.node), share: child.share })),
  };
}

/** Where every pane and sash goes. */
export function arrange(root: LayoutNode) {
  const boxes = new Map<number, Box>();
  const sashes: Sash[] = [];
  const place = (node: LayoutNode, box: Box, path: number[]) => {
    if (isPane(node)) {
      boxes.set(node.pane, box);
      return;
    }
    const direction = node.direction;
    let start = 0;
    node.children.forEach((child, index) => {
      const part =
        direction === "columns"
          ? { ...box, x: box.x + start * box.width, width: child.share * box.width }
          : { ...box, y: box.y + start * box.height, height: child.share * box.height };
      if (index > 0) {
        const line = direction === "columns" ? { ...part, width: 0 } : { ...part, height: 0 };
        sashes.push({ ...line, id: `${path.join(".")}/${index}`, direction, path, index, parent: box });
      }
      place(child.node, part, [...path, index]);
      start += child.share;
    });
  };
  place(root, { x: 0, y: 0, width: 1, height: 1 }, []);
  return { boxes, sashes };
}

/** A sash moved to `at`, a fraction of its split. */
export function resized(root: LayoutNode, sash: Pick<Sash, "path" | "index">, at: number): LayoutNode {
  const visit = (node: LayoutNode, depth: number): LayoutNode => {
    if (isPane(node)) return node;
    const children = node.children.map((child) => ({ ...child }));
    if (depth < sash.path.length) {
      const step = sash.path[depth];
      children[step].node = visit(children[step].node, depth + 1);
    } else {
      const first = children[sash.index - 1];
      const second = children[sash.index];
      const before = children.slice(0, sash.index - 1).reduce((sum, child) => sum + child.share, 0);
      const both = first.share + second.share;
      const least = Math.min(MIN_SHARE, both / 2);
      first.share = Math.min(both - least, Math.max(least, at - before));
      second.share = both - first.share;
    }
    return { direction: node.direction, children };
  };
  return visit(root, 0);
}

const even = (direction: Direction, ...nodes: LayoutNode[]): Split => ({
  direction,
  children: nodes.map((node) => ({ node, share: 1 / nodes.length })),
});

const PRESETS: Record<Preset, { slots: number; build: (pane: (i: number) => LayoutNode) => LayoutNode }> = {
  single: { slots: 1, build: (p) => p(0) },
  twoColumns: { slots: 2, build: (p) => even("columns", p(0), p(1)) },
  threeColumns: { slots: 3, build: (p) => even("columns", p(0), p(1), p(2)) },
  twoRows: { slots: 2, build: (p) => even("rows", p(0), p(1)) },
  threeRows: { slots: 3, build: (p) => even("rows", p(0), p(1), p(2)) },
  grid: { slots: 4, build: (p) => even("rows", even("columns", p(0), p(1)), even("columns", p(2), p(3))) },
  twoRowsRight: { slots: 3, build: (p) => even("columns", p(0), even("rows", p(1), p(2))) },
  twoColumnsBottom: { slots: 3, build: (p) => even("rows", p(0), even("columns", p(1), p(2))) },
};

export const presetSlots = (preset: Preset) => PRESETS[preset].slots;

/** The preset with evenly shared room, the panes `keys` in reading order. */
export const presetLayout = (preset: Preset, keys: number[]) => PRESETS[preset].build((i) => ({ pane: keys[i] }));

const shape = (node: LayoutNode): string =>
  isPane(node) ? "pane" : `${node.direction}(${node.children.map((child) => shape(child.node)).join()})`;

/** The preset this layout is, whatever its sizes; null if none. */
export function presetOf(node: LayoutNode): Preset | null {
  const wanted = shape(node);
  const names = Object.keys(PRESETS) as Preset[];
  return names.find((name) => shape(PRESETS[name].build(() => ({ pane: 0 }))) === wanted) ?? null;
}

/** The same tree with other leaves, made in reading order. */
export function mapLeaves<Leaf extends object, To>(node: Tree<Leaf>, leaf: (value: Leaf) => To): Tree<To> {
  if (!("direction" in node)) return leaf(node as Leaf);
  const { direction, children } = node as Branch<Leaf>;
  return { direction, children: children.map((child) => ({ node: mapLeaves(child.node, leaf), share: child.share })) };
}
