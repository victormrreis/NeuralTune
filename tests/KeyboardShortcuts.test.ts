import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { RatingManager } from '../src/core/RatingManager.ts';
import {
  KeyboardShortcuts,
  SpicetifyKeyboardBridge,
  isTextEntryTarget,
  resolveShortcut
} from '../src/ui/KeyboardShortcuts.ts';
import { TrackMetadata } from '../src/types/index.ts';

const chord = { ctrlKey: true, altKey: true };

const current: TrackMetadata = {
  uri: 'spotify:track:now',
  name: 'Now',
  artists: [],
  album: { name: '', uri: '' }
};

function setup() {
  const calls: string[] = [];
  const bridge: SpicetifyKeyboardBridge = {
    notify: (message) => { calls.push(`notify:${message}`); },
    getCurrentTrack: () => current,
    openDashboard: () => { calls.push('dashboard'); },
    skipNext: () => { calls.push('skip'); },
    skipBlocked: (uri) => { calls.push(`skipBlocked:${uri}`); },
    toggleHeart: () => { calls.push('heart'); },
    exportAll: () => { calls.push('export'); },
    toggleAutopilot: () => { calls.push('autopilot'); }
  };
  const storage = new MemoryStorage();
  const manager = new RatingManager(storage);
  return { calls, storage, manager, shortcuts: new KeyboardShortcuts(manager, bridge) };
}

function keyEvent(overrides: Record<string, unknown>) {
  const log = { prevented: 0, stopped: 0 };
  const event = {
    ...chord,
    repeat: false,
    target: { tagName: 'BODY', getAttribute: () => null },
    composedPath() { return [this.target]; },
    preventDefault() { log.prevented++; },
    stopImmediatePropagation() { log.stopped++; },
    ...overrides
  };
  return { event: event as unknown as KeyboardEvent, log };
}

test('resolveShortcut: ABNT2 superscripts still map to the physical digits', () => {
  const abnt2: Array<[string, string, number]> = [
    ['Digit1', '¹', 1], ['Digit2', '²', 2], ['Digit3', '³', 3],
    ['Digit4', '£', 4], ['Digit5', '¢', 5], ['Digit0', '0', 0]
  ];

  for (const [code, key, rating] of abnt2) {
    assert.deepEqual(resolveShortcut({ ...chord, code, key }), { type: 'rate', rating });
  }
});

test('resolveShortcut: the numeric keypad rates too, 6 to 9 do nothing', () => {
  assert.deepEqual(resolveShortcut({ ...chord, code: 'Numpad4', key: '4' }), { type: 'rate', rating: 4 });
  assert.equal(resolveShortcut({ ...chord, code: 'Digit6', key: '¬' }), null);
  assert.equal(resolveShortcut({ ...chord, code: 'Numpad9', key: '9' }), null);
  assert.equal(resolveShortcut({ ...chord, code: 'NumpadEnter', key: 'Enter' }), null);
});

test('resolveShortcut: every letter action, including E, which ABNT2 reports as °', () => {
  assert.deepEqual(resolveShortcut({ ...chord, code: 'KeyM', key: 'µ' }), { type: 'dashboard' });
  assert.deepEqual(resolveShortcut({ ...chord, code: 'KeyZ', key: 'z' }), { type: 'undo' });
  assert.deepEqual(resolveShortcut({ ...chord, code: 'KeyY', key: 'y' }), { type: 'redo' });
  assert.deepEqual(resolveShortcut({ ...chord, code: 'KeyE', key: '°' }), { type: 'export' });
  assert.deepEqual(resolveShortcut({ ...chord, code: 'KeyH', key: 'h' }), { type: 'rate', rating: 0 });
  assert.deepEqual(resolveShortcut({ ...chord, code: 'KeyL', key: 'l' }), { type: 'heart' });
  assert.deepEqual(resolveShortcut({ ...chord, code: 'KeyN', key: 'n' }), { type: 'skip' });
  assert.equal(resolveShortcut({ ...chord, code: 'KeyQ', key: '/' }), null);
});

test('resolveShortcut: a character on another key must not trigger through event.key', () => {
  assert.equal(resolveShortcut({ ...chord, code: 'Backslash', key: 'm' }), null);
});

test('resolveShortcut: AltGr reported only through getModifierState', () => {
  const event = {
    ctrlKey: false,
    altKey: false,
    code: 'Digit3',
    key: '³',
    getModifierState: (key: string) => key === 'AltGraph'
  };
  assert.deepEqual(resolveShortcut(event), { type: 'rate', rating: 3 });
});

test('resolveShortcut: needs the full chord, and no extra modifier', () => {
  assert.equal(resolveShortcut({ ctrlKey: true, altKey: false, code: 'Digit1' }), null);
  assert.equal(resolveShortcut({ ctrlKey: false, altKey: true, code: 'Digit1' }), null);
  assert.equal(resolveShortcut({ ctrlKey: false, altKey: false, code: 'Digit1' }), null);
  assert.equal(resolveShortcut({ ...chord, shiftKey: true, code: 'Digit1' }), null);
  assert.equal(resolveShortcut({ ...chord, metaKey: true, code: 'Digit1' }), null);
});

test('resolveShortcut: falls back to event.key only when there is no code', () => {
  assert.deepEqual(resolveShortcut({ ...chord, code: '', key: '2' }), { type: 'rate', rating: 2 });
  assert.deepEqual(resolveShortcut({ ...chord, key: 'M' }), { type: 'dashboard' });
});

test('isTextEntryTarget: only real text inputs block shortcuts', () => {
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isTextEntryTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTextEntryTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextEntryTarget({ tagName: 'DIV', getAttribute: () => 'textbox' }), true);
});

test('isTextEntryTarget: the volume slider and other controls do not block shortcuts', () => {
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(isTextEntryTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextEntryTarget({ tagName: 'BUTTON', getAttribute: () => null }), false);
  assert.equal(isTextEntryTarget({ tagName: 'BODY' }), false);
  assert.equal(isTextEntryTarget(null), false);
});

test('KeyboardShortcuts: handled keys are stopped, so the chord never reaches Spotify', () => {
  const { shortcuts } = setup();
  const { event, log } = keyEvent({ code: 'Digit4', key: '£' });

  shortcuts.handleKeyDown(event);

  assert.equal(log.prevented, 1);
  assert.equal(log.stopped, 1);
});

test('KeyboardShortcuts: typing in a search box is left alone', async () => {
  const { shortcuts, storage } = setup();
  const { event, log } = keyEvent({ code: 'Digit2', key: '²', target: { tagName: 'INPUT', type: 'search' } });

  shortcuts.handleKeyDown(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(log.prevented, 0);
  assert.equal((await storage.getAllRatings()).length, 0);
});

test('KeyboardShortcuts: the text check sees through shadow DOM retargeting', () => {
  const { shortcuts } = setup();
  const { event, log } = keyEvent({
    code: 'Digit2',
    target: { tagName: 'DIV', getAttribute: () => null },
    composedPath: () => [{ tagName: 'INPUT', type: 'text' }]
  });

  shortcuts.handleKeyDown(event);

  assert.equal(log.prevented, 0);
});

test('KeyboardShortcuts: a held key fires once', async () => {
  const { shortcuts, storage, calls } = setup();
  const { event, log } = keyEvent({ code: 'KeyH', repeat: true });

  shortcuts.handleKeyDown(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(log.prevented, 1);
  assert.equal((await storage.getAllRatings()).length, 0);
  assert.equal(calls.length, 0);
});

test('KeyboardShortcuts: Ctrl+Alt+1..5 rates without skipping', async () => {
  const { shortcuts, storage, calls } = setup();

  await shortcuts.execute({ type: 'rate', rating: 5 });

  assert.equal((await storage.getRating(current.uri))?.rating, 5);
  assert.ok(!calls.some((c) => c.startsWith('skip')));
});

test('KeyboardShortcuts: 0★ blocks and skips through the guardian only', async () => {
  const { shortcuts, storage, calls } = setup();

  await shortcuts.execute({ type: 'rate', rating: 0 });

  assert.equal(storage.isTrackBlocked(current.uri), true);
  assert.equal(calls.filter((c) => c === `skipBlocked:${current.uri}`).length, 1);
  assert.ok(!calls.includes('skip'));
});

test('KeyboardShortcuts: undo and redo apply and report an empty history', async () => {
  const { shortcuts, storage, calls } = setup();

  await shortcuts.execute({ type: 'undo' });
  assert.ok(calls.some((c) => c.includes('Nada para desfazer')));

  await shortcuts.execute({ type: 'rate', rating: 4 });
  await shortcuts.execute({ type: 'undo' });
  assert.equal(await storage.getRating(current.uri), null);

  await shortcuts.execute({ type: 'redo' });
  assert.equal((await storage.getRating(current.uri))?.rating, 4);
});

test('KeyboardShortcuts: export, dashboard, heart and skip reach the bridge', async () => {
  const { shortcuts, calls } = setup();

  await shortcuts.execute({ type: 'export' });
  await shortcuts.execute({ type: 'dashboard' });
  await shortcuts.execute({ type: 'heart' });
  await shortcuts.execute({ type: 'skip' });

  assert.deepEqual(calls, ['export', 'dashboard', 'heart', 'skip']);
});

test('KeyboardShortcuts: a failing action tells the user', async () => {
  const { manager, calls } = setup();
  const bridge: SpicetifyKeyboardBridge = {
    notify: (message) => { calls.push(message); },
    getCurrentTrack: () => current,
    openDashboard: () => undefined,
    skipNext: () => undefined,
    skipBlocked: () => undefined,
    toggleHeart: () => undefined,
    exportAll: () => { throw new Error('disk full'); },
    toggleAutopilot: () => undefined
  };
  const shortcuts = new KeyboardShortcuts(manager, bridge);
  const originalError = console.error;
  console.error = () => undefined;

  shortcuts.handleKeyDown(keyEvent({ code: 'KeyE', key: '°' }).event);
  await new Promise((resolve) => setImmediate(resolve));
  console.error = originalError;

  assert.ok(calls.some((c) => c.includes('Não foi possível')));
});
