import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useSessionArtifactState } from '../src/hooks/useSessionArtifactState';
import { artifactStateForUrl, changeArtifactState, readArtifactState, widgetStateJson, withArtifactState } from '../src/lib/sessionArtifactState';
import { withWidgetDom } from './widgetDom';

test('state accepts bounded JSON only', () => {
  assert.equal(widgetStateJson({ version: 1, inputs: [true, null, 3] }), '{"version":1,"inputs":[true,null,3]}');
  for (const value of [undefined, Infinity, new Map(), new Date(), { a: undefined }, 'é'.repeat(9000), Array(5000).fill(1)]) assert.equal(widgetStateJson(value), null);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(widgetStateJson(cyclic), null);
});

test('opaque preview handles preserve revision identity and isolate other revisions', () => {
  const ref = { treeId: 'private-tree', artifactId: 'chart', revision: 'revision-1' };
  const url = withArtifactState('http://127.0.0.1:1234/view', ref);
  assert.ok(!url.includes(ref.treeId));
  assert.deepEqual(artifactStateForUrl(url), ref);
  assert.notEqual(withArtifactState('http://127.0.0.1:1234/view', { ...ref, revision: 'revision-2' }), url);
  assert.equal(artifactStateForUrl('bad-url'), null);
});

test('bridge saves only its own opted-in frame and reset cancels pending saves', async () => {
  await withWidgetDom(async (window) => {
    const reference = { treeId: 'state-test-tree', artifactId: 'widget', revision: '1' };
    let stored = { enabled: false, value: null as unknown };
    const saves: unknown[] = [];
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { action?: string; value?: unknown }) => {
      if (command === 'research_artifact_state_update') {
        switch (args.action) {
          case 'enable': stored = { ...stored, enabled: true }; break;
          case 'save': saves.push(args.value); stored = { ...stored, value: args.value }; break;
          case 'reset': stored = { ...stored, value: null }; break;
        }
      }
      return { ...stored };
    } } });
    function Harness() {
      const ref = useRef<HTMLIFrameElement | null>(null);
      useSessionArtifactState(reference, ref, 'http://127.0.0.1/widget', true);
      return createElement('iframe', { ref });
    }
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const send = (own: boolean, value: unknown) => window.dispatchEvent(new window.MessageEvent('message', { source: own ? container.querySelector('iframe')!.contentWindow : window as unknown as Window, data: { type: 'session-widget-state-save', value } }));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 280));
    try {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => { send(true, { n: 1 }); await settle(); });
      assert.equal(saves.length, 0);
      await act(async () => changeArtifactState(reference, 'enable'));
      await act(async () => { send(false, { n: 2 }); await settle(); });
      assert.equal(saves.length, 0);
      await act(async () => { send(true, { n: 3 }); await settle(); });
      assert.deepEqual(saves, [{ n: 3 }]);
      await act(async () => { send(true, { n: 4 }); await changeArtifactState(reference, 'reset'); await settle(); });
      assert.deepEqual(saves, [{ n: 3 }], 'pending input cannot undo Reset');
      assert.equal(readArtifactState(reference).config?.value, null);
    } finally { await act(async () => root.unmount()); }
  });
});

test('latest inputs win over debounce and delayed backend responses', async () => {
  const { stageArtifactInputs, flushArtifactInputs, loadArtifactState } = await import('../src/lib/sessionArtifactState');
  await withWidgetDom(async (window) => {
    const reference = { treeId: 'race-tree', artifactId: 'chart', revision: 'race' };
    let stored: unknown = 'A';
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { value: unknown }) => {
      if (command === 'research_artifact_state_update') {
        if (args.value === 'B') { started!(); await new Promise<void>((resolve) => { release = resolve; }); }
        stored = args.value;
      }
      return { enabled: true, value: stored };
    } } });
    await loadArtifactState(reference);
    stageArtifactInputs(reference, '"B"');
    stageArtifactInputs(reference, '"A"');
    flushArtifactInputs(reference);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stored, 'A', 'debounced return to initial value persists');
    stageArtifactInputs(reference, '"B"'); flushArtifactInputs(reference);
    await inFlight;
    stageArtifactInputs(reference, '"A"');
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(readArtifactState(reference).config?.value, 'A', 'slow B response never restores over newer A');
    flushArtifactInputs(reference);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stored, 'A', 'latest A commits after in-flight B');
  });
});

test('identical input can be retried after a failed optimistic save', async () => {
  const { stageArtifactInputs, flushArtifactInputs, loadArtifactState } = await import('../src/lib/sessionArtifactState');
  await withWidgetDom(async (window) => {
    const reference = { treeId: 'retry-tree', artifactId: 'chart', revision: 'retry' };
    let calls = 0;
    let stored: unknown = 'A';
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { value: unknown }) => {
      if (command === 'research_artifact_state_update') {
        if (++calls === 1) throw new Error('disk unavailable');
        stored = args.value;
      }
      return { enabled: true, value: stored };
    } } });
    await loadArtifactState(reference);
    stageArtifactInputs(reference, '"B"'); flushArtifactInputs(reference);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(readArtifactState(reference).error);
    stageArtifactInputs(reference, '"B"'); flushArtifactInputs(reference);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stored, 'B');
    assert.equal(readArtifactState(reference).error, '');
  });
});
