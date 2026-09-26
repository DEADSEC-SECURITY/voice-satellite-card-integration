const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
async function fixture() {
  const context = vm.createContext({ console, Float32Array, Date });
  const module = new vm.SourceTextModule(
    readFileSync(path.join(__dirname, '../src/wake-word/oww/inference.js'), 'utf8'),
    { context }
  );
  await module.link((specifier) => {
    const values = specifier.endsWith('model-runner.js')
      ? { compileOwwModel() {} }
      : specifier.endsWith('melspectrogram-shapes.js')
        ? { MELSPECTROGRAM_SHAPES_1280: {}, MELSPECTROGRAM_SHAPES_1760: {} }
        : { FusedOwwGpuFrontend: class {} };
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) {
          this.setExport(key, value);
        }
      },
      { context }
    );
  });
  await module.evaluate();
  let calls = 0;
  const fake = (invoke) => ({ createState: () => ({}), invoke });
  const engine = new module.namespace.OwwInference({
    melspectrogram: fake(() => new Float32Array(8 * 32)),
    embedding: fake(() => new Float32Array(96).fill(3)),
    classifier: fake(() => {
      calls++;
      return [0.99];
    }),
  });
  await engine.ready;
  return { engine, calls: () => calls, chunk: new Float32Array(1280) };
}
test('synthetic startup history cannot score, even with an always-high classifier', async () => {
  const scenario = await fixture();
  for (let i = 0; i < 24; i++) {
    assert.deepEqual(Object.keys((await scenario.engine.processChunk(scenario.chunk)).probs), []);
  }
  assert.equal(scenario.calls(), 0);
  assert.equal((await scenario.engine.processChunk(scenario.chunk)).probs.default, 0.99);
  assert.equal(scenario.calls(), 1);
});
test('resume/reset requires fresh real history and then preserves normal scoring', async () => {
  const scenario = await fixture();
  for (let i = 0; i < 30; i++) {
    await scenario.engine.processChunk(scenario.chunk);
  }
  assert.equal(scenario.calls(), 6);
  scenario.engine.reset();
  for (let i = 0; i < 24; i++) {
    assert.deepEqual(Object.keys((await scenario.engine.processChunk(scenario.chunk)).probs), []);
  }
  assert.equal(scenario.calls(), 6);
  assert.equal((await scenario.engine.processChunk(scenario.chunk)).probs.default, 0.99);
  assert.equal(scenario.calls(), 7);
});
