import assert from 'node:assert/strict';
import { test } from 'node:test';

test('CPU profiling drains research persistence without calling the database writer', async () => {
  const originalExecArgv = [...process.execArgv];
  process.execArgv.push('--cpu-prof');

  try {
    // Import after enabling the flag to emulate the profiling process at startup.
    const { ReliablePersistenceQueue } = await import(
      '../services/reliable-persistence-queue.js'
    );
    let written = 0;
    const queue = new ReliablePersistenceQueue<number>(
      'Research profile test',
      async (batch) => { written += batch.length; },
    );

    for (let index = 0; index < 237; index++) {
      queue.enqueue(index);
    }

    await queue.stop();

    assert.equal(written, 0);
    assert.throws(() => queue.enqueue(238), /queue has stopped/);
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
  }
});
