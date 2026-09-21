import test from 'node:test';
import assert from 'node:assert/strict';
import { installDownloads } from '../src/downloads.js';

test('native detached exports and visible API links fetch bytes through the carrier', async () => {
  const saved = [], paths = [], notices = [];
  let click, fail = false;
  class Anchor {
    getAttribute(name) { return this[name]; }
    click() { saved.push({ href: this.href, name: this.download }); }
  }
  const document = {
    createElement: name => name === 'a' ? new Anchor() : { setAttribute() {} },
    addEventListener: (_, handler) => { click = handler; },
    body: { prepend: notice => notices.push(notice.textContent) },
  };
  installDownloads({ HTMLAnchorElement: Anchor, document, location: { href: 'https://hub.test/api/dsh/frame' }, URL,
    setTimeout: callback => callback(),
    fetch: async path => { paths.push(path); return new Response('test archive', { status: fail ? 404 : 200 }); },
  });
  const detached = new Anchor();
  detached.href = 'http://dsh.internal/api/session.export?sessionId=test'; detached.download = 'test.zip';
  detached.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(paths, ['/api/session.export?sessionId=test']);
  assert.match(saved[0].href, /^blob:/);
  assert.equal(saved[0].name, 'test.zip');
  let prevented = false;
  fail = true;
  click({ target: { closest: () => detached }, preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(prevented);
  assert.equal(notices.length, 1);
  const ordinary = new Anchor(); ordinary.href = 'https://example.test/'; ordinary.click();
  assert.equal(saved.at(-1).href, ordinary.href);
  assert.equal(paths.length, 2);
});
