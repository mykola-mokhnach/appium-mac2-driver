import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import {AppiumIpc} from 'appium/driver.js';

import {
  resetSharedIpcForTesting,
  sessionClaimHandler,
  setSharedIpcForTesting,
} from '../../lib/session-claim-handler.js';

const log = {debug() {}, info() {}, warn() {}, error() {}};

function makeDriver(sessionId: string, onDelete: () => Promise<void> = async () => {}) {
  const driver: any = {
    sessionId,
    log,
    startUnexpectedShutdown: async () => {
      sessionClaimHandler.unregisterActiveSession(driver);
      await onDelete();
      driver.sessionId = null;
    },
  };
  return driver;
}

describe('SessionClaimHandler', () => {
  afterEach(() => resetSharedIpcForTesting());

  it('terminates the previous session and waits for it to quit', async () => {
    setSharedIpcForTesting(new AppiumIpc());
    const events: string[] = [];
    const oldDriver = makeDriver('old', async () => {
      await new Promise((r) => setTimeout(r, 100));
      events.push('old-deleted');
    });
    await sessionClaimHandler.registerActiveSession(oldDriver);

    const newDriver = makeDriver('new');
    await sessionClaimHandler.registerActiveSession(newDriver);
    await sessionClaimHandler.claimHost(newDriver);
    events.push('claimed');

    assert.deepEqual(events, ['old-deleted', 'claimed']);
    assert.equal(oldDriver.sessionId, null);
    assert.equal(newDriver.sessionId, 'new');
  });

  it('does nothing if there is no other session', async () => {
    setSharedIpcForTesting(new AppiumIpc());
    const driver = makeDriver('only');
    await sessionClaimHandler.registerActiveSession(driver);
    await sessionClaimHandler.claimHost(driver);
    assert.equal(driver.sessionId, 'only');
  });

  it('does not terminate sessions that have quit already', async () => {
    setSharedIpcForTesting(new AppiumIpc());
    let deletions = 0;
    const oldDriver = makeDriver('old', async () => {
      deletions++;
    });
    await sessionClaimHandler.registerActiveSession(oldDriver);
    await oldDriver.startUnexpectedShutdown();

    const newDriver = makeDriver('new');
    await sessionClaimHandler.registerActiveSession(newDriver);
    await sessionClaimHandler.claimHost(newDriver);
    assert.equal(deletions, 1);
  });

  it('skips the claim if IPC is unavailable', async () => {
    setSharedIpcForTesting(undefined);
    const driver = makeDriver('s');
    await sessionClaimHandler.registerActiveSession(driver);
    await sessionClaimHandler.claimHost(driver);
    assert.equal(driver.sessionId, 's');
  });

  it('lets the newest of concurrently starting sessions win', async () => {
    setSharedIpcForTesting(new AppiumIpc());
    const events: string[] = [];
    const start = async (driver: any) =>
      await sessionClaimHandler.runExclusive(async () => {
        await sessionClaimHandler.registerActiveSession(driver);
        await sessionClaimHandler.claimHost(driver);
        events.push(`${driver.sessionId}-starting`);
        await new Promise((r) => setTimeout(r, 50));
        events.push(`${driver.sessionId}-started`);
      });
    const first = makeDriver('first', async () => {
      events.push('first-deleted');
    });
    const second = makeDriver('second', async () => {
      events.push('second-deleted');
    });

    await Promise.all([start(first), start(second)]);

    assert.deepEqual(events, ['first-starting', 'first-started', 'first-deleted', 'second-starting', 'second-started']);
    assert.equal(first.sessionId, null);
    assert.equal(second.sessionId, 'second');
  });
});
