import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { RatingManager } from '../src/core/RatingManager.ts';
import { TrackMetadata } from '../src/types/index.ts';

/** Just enough DOM for the widget, counting every write that could cause a repaint. */
class FakeNode {
  tagName: string;
  className = '';
  type = '';
  title = '';
  textContent = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  onclick: ((e: { stopPropagation(): void }) => void) | null = null;
  onmouseenter: (() => void) | null = null;
  onmouseleave: (() => void) | null = null;
  styleWrites: string[] = [];
  style = {
    cssText: '',
    values: new Map<string, string>(),
    setProperty: (property: string, value: string) => {
      this.styleWrites.push(`${property}=${value}`);
      this.style.values.set(property, value);
    }
  };

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  appendChild(child: FakeNode) {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, reference: FakeNode | null) {
    child.parentElement?.removeChild(child);
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentElement = this;
    fakeDom.inserts++;
    return child;
  }
  removeChild(child: FakeNode) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentElement = null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get isConnected(): boolean {
    let node: FakeNode | null = this;
    while (node) {
      if (node === fakeDom.root) return true;
      node = node.parentElement;
    }
    return false;
  }
  contains(other: FakeNode): boolean {
    let node: FakeNode | null = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const attr = /^\[data-testid="(.+)"\]$/.exec(selector);
    if (attr) return this.dataset.testid === attr[1];
    return this.tagName === selector.toUpperCase();
  }
  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const fakeDom = { root: new FakeNode('html'), inserts: 0 };

const fakeDocument = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  querySelector: (selector: string) => fakeDom.root.querySelector(selector)
};
Object.assign(globalThis, { document: fakeDocument });

const { StarRatingWidget } = await import('../src/ui/StarRatingWidget.ts');

const song: TrackMetadata = { uri: 'spotify:track:a', name: 'A', artists: [], album: { name: '', uri: '' } };
const other: TrackMetadata = { uri: 'spotify:track:b', name: 'B', artists: [], album: { name: '', uri: '' } };

function buildPlayerBar() {
  fakeDom.root = new FakeNode('html');
  fakeDom.inserts = 0;

  const unrelatedRow = new FakeNode('div');
  const rowButton = new FakeNode('button');
  rowButton.dataset.testid = 'add-button';
  unrelatedRow.appendChild(rowButton);
  fakeDom.root.appendChild(unrelatedRow);

  const bar = new FakeNode('div');
  bar.className = 'Root__now-playing-bar';
  const left = new FakeNode('div');
  const addButton = new FakeNode('button');
  addButton.dataset.testid = 'add-button';
  const neighbor = new FakeNode('button');
  left.appendChild(addButton);
  left.appendChild(neighbor);
  bar.appendChild(left);
  fakeDom.root.appendChild(bar);

  return { bar, left, addButton, neighbor, rowButton };
}

function setup() {
  const manager = new RatingManager(new MemoryStorage());
  const widget = new StarRatingWidget(manager);
  const node = (widget as unknown as { container: FakeNode }).container;
  const star = (i: number) => node.children[i + 1];
  const block = node.children[0];
  return { manager, widget, node, star, block };
}

test('StarRatingWidget: sits right after the add button of the player bar, not of a track row', () => {
  const { left, addButton, neighbor, rowButton } = buildPlayerBar();
  const { widget, node } = setup();

  widget.ensureMounted();

  assert.equal(node.parentElement, left);
  assert.equal(addButton.nextSibling, node);
  assert.equal(node.nextSibling, neighbor);
  assert.equal(rowButton.nextSibling, null);
});

test('StarRatingWidget: a healthy widget costs no DOM write at all', () => {
  buildPlayerBar();
  const { widget } = setup();
  widget.ensureMounted();

  const inserts = fakeDom.inserts;
  for (let i = 0; i < 100; i++) widget.ensureMounted();

  assert.equal(fakeDom.inserts, inserts);
});

test('StarRatingWidget: survives React rebuilding the bar, as the same node', () => {
  const first = buildPlayerBar();
  const { widget, node, star } = setup();
  widget.ensureMounted();
  const icon = star(1).children[0];

  first.left.removeChild(node);
  assert.equal(widget.isMounted(), false);

  const replacementParent = new FakeNode('div');
  const replacementButton = new FakeNode('button');
  replacementButton.dataset.testid = 'add-button';
  replacementParent.appendChild(replacementButton);
  first.bar.removeChild(first.left);
  first.bar.appendChild(replacementParent);

  widget.ensureMounted();

  assert.equal(widget.isMounted(), true);
  assert.equal(node.parentElement, replacementParent);
  assert.equal(star(1).children[0], icon);
});

test('StarRatingWidget: without an add button it falls back, and moves once the button appears', () => {
  fakeDom.root = new FakeNode('html');
  const bar = new FakeNode('div');
  bar.className = 'Root__now-playing-bar';
  const nowPlaying = new FakeNode('div');
  nowPlaying.className = 'main-nowPlayingWidget-nowPlaying';
  bar.appendChild(nowPlaying);
  fakeDom.root.appendChild(bar);

  const { widget, node } = setup();
  widget.ensureMounted();
  assert.equal(node.parentElement, nowPlaying);

  const holder = new FakeNode('div');
  const button = new FakeNode('button');
  button.dataset.testid = 'add-button';
  holder.appendChild(button);
  bar.appendChild(holder);

  widget.ensureMounted();
  assert.equal(node.parentElement, holder);
});

test('StarRatingWidget: no player bar yet is not an error', () => {
  fakeDom.root = new FakeNode('html');
  const { widget } = setup();
  assert.doesNotThrow(() => widget.ensureMounted());
  assert.equal(widget.isMounted(), false);
});

test('StarRatingWidget: rating changes only colors, the node tree never changes', async () => {
  buildPlayerBar();
  const { widget, node, star, block, manager } = setup();
  widget.ensureMounted();
  await widget.updateTrack(song);

  const tree = node.children.flatMap((child) => [child, ...child.children]);
  const inserts = fakeDom.inserts;

  await manager.rateTrack(song, 4);
  await widget.updateTrack(song);

  assert.deepEqual(node.children.flatMap((child) => [child, ...child.children]), tree);
  assert.equal(fakeDom.inserts, inserts);
  assert.equal(star(4).style.values.get('color'), '#1db954');
  assert.equal(star(5).style.values.get('color'), 'rgba(255, 255, 255, 0.45)');

  await manager.rateTrack(song, 0);
  await widget.updateTrack(song);
  assert.equal(block.style.values.get('color'), '#e22134');
  assert.equal(star(1).style.values.get('color'), 'rgba(255, 255, 255, 0.45)');
});

test('StarRatingWidget: repeating a state writes no style', async () => {
  buildPlayerBar();
  const { widget, star, manager } = setup();
  await manager.rateTrack(song, 3);
  await widget.updateTrack(song);

  const writes = star(1).styleWrites.length;
  for (let i = 0; i < 50; i++) await widget.updateTrack(song);

  assert.equal(star(1).styleWrites.length, writes);
});

test('StarRatingWidget: a slow lookup of the previous track cannot paint over the new one', async () => {
  buildPlayerBar();
  const { widget, star, manager } = setup();
  await manager.rateTrack(song, 5);

  const original = manager.getRating.bind(manager);
  manager.getRating = async (uri: string) => {
    if (uri === song.uri) await new Promise((resolve) => setTimeout(resolve, 10));
    return original(uri);
  };

  const stale = widget.updateTrack(song);
  await widget.updateTrack(other);
  await stale;

  assert.equal(star(5).style.values.get('color'), 'rgba(255, 255, 255, 0.45)');
});

test('StarRatingWidget: clicking the same star clears the rating, double clicks do not race', async () => {
  buildPlayerBar();
  const { widget, star, manager } = setup();
  await widget.updateTrack(song);
  const click = () => star(3).onclick?.({ stopPropagation() {} });

  click();
  click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await manager.getRating(song.uri))?.rating, 3);

  click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await manager.getRating(song.uri), null);
});

test('StarRatingWidget: hover previews and leaving restores the real rating', async () => {
  buildPlayerBar();
  const { widget, star, manager } = setup();
  await manager.rateTrack(song, 2);
  await widget.updateTrack(song);

  star(4).onmouseenter?.();
  assert.equal(star(4).style.values.get('color'), '#1db954');

  star(4).onmouseleave?.();
  assert.equal(star(4).style.values.get('color'), 'rgba(255, 255, 255, 0.45)');
  assert.equal(star(2).style.values.get('color'), '#1db954');
});
