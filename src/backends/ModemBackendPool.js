'use strict';

/**
 * ModemBackendPool — manages a pre-warmed SlmodemBackend so calls
 * can activate the modem without paying VM boot cost at call time.
 *
 * ─── Why pre-warming matters ────────────────────────────────────
 *
 * A cold SlmodemBackend takes ~8 seconds to boot (QEMU TCG + Linux
 * kernel + userland init + slmodemd daemon startup + HELLO). During
 * that window:
 *   - The caller is ringing, waiting for our side to answer
 *   - Any RTP audio that arrives is dropped (VM not ready)
 *   - Various kernel/libuv/page-cache pieces warm up incrementally
 *   - When the first real audio sample finally arrives at slmodemd,
 *     it hits a pipeline in an unsettled state — slmodemd's DCR
 *     calibration runs on those early samples, so any transient
 *     distortion biases the DSP for the rest of the call
 *
 * Pre-warming fixes all of this. At synthmodem startup we boot a
 * VM immediately. When a SIP call arrives the VM is already idle-
 * ready, and we just need to issue ATA to start the answer tone.
 *
 * ─── Lifecycle ──────────────────────────────────────────────────
 *
 *   startup:     pool.start()         — boot 1 warm VM, wait HELLO
 *   incoming:    pool.checkout()      — hand that VM to CallSession
 *   hangup:      pool.recycle(bk)     — kill that VM, boot a fresh one
 *   shutdown:    pool.stop()          — kill any warm/idle VM
 *
 * ─── Why always-fresh instead of ATZ reuse ──────────────────────
 *
 * slmodemd has accumulated state across DP changes and handshake
 * attempts that doesn't fully reset with ATZ. The vendored
 * proprietary datapumps carry AGC calibration, scrambler state,
 * V.8 capability flags, and more across calls. Booting a fresh VM
 * per call costs ~8 seconds of background warmup but guarantees
 * reproducible, well-defined state at each call's ATA.
 *
 * Since the system is single-caller by design (enforced at the SIP
 * layer in index.js), booting the replacement VM in the background
 * during the current call's post-train hold means most of the
 * warmup overlaps with active call time — by the time the user
 * finishes their session, the next VM is already warm.
 *
 * ─── State machine ──────────────────────────────────────────────
 *
 *           ┌─────────┐    start()    ┌───────────┐
 *           │  empty  │ ───────────▶ │  warming  │
 *           └─────────┘               └─────┬─────┘
 *                ▲                          │ HELLO received
 *                │                          ▼
 *           stop()                     ┌─────────┐
 *                │         checkout()  │  ready  │
 *                │     ┌───────────── └────┬────┘
 *                │     │                   │
 *                │     ▼                   │
 *          ┌───────────┐   recycle(bk)     │
 *          │checked_out│ ─────────────────┘
 *          └───────────┘   (→ warming)
 *
 * In checked_out state, the pool holds no backend — the caller
 * owns it. On recycle() the pool doesn't touch the returned
 * backend directly (the caller is expected to have called
 * backend.stop() already); it just boots a fresh one.
 */

const EventEmitter = require('events');
const { SlmodemBackend } = require('./SlmodemBackend');
const { makeLogger }     = require('../logger');

const log = makeLogger('ModemBackendPool');

class ModemBackendPool extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.backendOpts] — opts passed to each SlmodemBackend
   *     constructor. See SlmodemBackend for the schema. Most commonly
   *     carries { role, vmOpts, modemCfg }.
   * @param {number} [opts.warmupTimeoutMs=30000] — max time to wait for
   *     a VM to reach ready state before giving up.
   */
  constructor(opts = {}) {
    super();
    this._backendOpts = opts.backendOpts || {};
    this._warmupTimeoutMs = opts.warmupTimeoutMs ?? 30000;

    /** @type {'empty'|'warming'|'ready'|'checked_out'|'stopped'} */
    this._state = 'empty';

    /** @type {SlmodemBackend|null} The currently-warm backend, if any. */
    this._backend = null;

    /** @type {Promise<SlmodemBackend>|null} Warmup in progress. */
    this._warmupPromise = null;

    /**
     * Set true when stop() has been called. Prevents background
     * recycle() warmups from spinning up after shutdown.
     */
    this._stopped = false;

    /**
     * Tracks any in-flight recycle (old backend teardown + new
     * warmup). stop() awaits this so it doesn't return while a
     * background replacement is still spinning up.
     */
    this._recyclePromise = null;
  }

  get state() { return this._state; }

  /**
   * Boot the initial warm backend. Call once at synthmodem startup.
   * Resolves when the backend is ready for activation. Rejects if
   * the warmup fails (e.g. QEMU missing, image corrupt).
   *
   * Safe to call more than once as a no-op if already started.
   */
  async start() {
    if (this._stopped) {
      throw new Error('ModemBackendPool: cannot start(); pool has been stopped');
    }
    if (this._state !== 'empty') {
      log.debug(`start() called in state ${this._state} — no-op`);
      return;
    }
    log.info('Pool starting — booting initial warm VM');
    await this._warmupOne();
    log.info('Pool ready');
  }

  /**
   * Hand out the currently-warm backend. Caller takes ownership;
   * pool transitions to 'checked_out'. Rejects if the pool is not
   * ready (still warming, already checked out, stopped, etc.).
   *
   * In the future we could block-and-wait instead of rejecting, but
   * the current synthmodem architecture rejects concurrent calls at
   * the SIP layer, so a pool being busy is always a programmer
   * error worth surfacing loudly.
   *
   * @returns {Promise<SlmodemBackend>}
   */
  async checkout() {
    if (this._stopped) {
      throw new Error('ModemBackendPool: checkout() on stopped pool');
    }
    // If warming is in progress, wait for it to finish. This smooths
    // over the race where a second call arrives within seconds of
    // the first ending (common in dev/testing).
    if (this._state === 'warming') {
      log.debug('checkout() waiting for warmup to complete');
      try {
        await this._warmupPromise;
      } catch (err) {
        // Warmup failed; bubble up with clearer framing.
        throw new Error(`ModemBackendPool: warmup failed during checkout — ${err.message}`);
      }
    }
    if (this._state !== 'ready' || !this._backend) {
      throw new Error(
        `ModemBackendPool: checkout() called in state ${this._state} ` +
        `(backend is ${this._backend ? 'present' : 'absent'})`);
    }
    const bk = this._backend;
    this._backend = null;
    this._state = 'checked_out';
    log.debug('checkout: backend handed off');
    return bk;
  }

  /**
   * Return a backend to the pool after the call has ended. The
   * caller is expected to have already called backend.stop() (or may
   * rely on us calling it — both are fine). We wait for the backend
   * to fully stop before booting a replacement, because the old VM
   * was listening on the same TCP ports we need to reuse. Starting
   * the new VM immediately races EADDRINUSE against the old one's
   * socket teardown.
   *
   * Does NOT wait for the replacement to be ready; fire-and-forget
   * beyond the stop. If the replacement fails, we log and emit
   * 'error'; the pool returns to 'empty' state and the next
   * checkout() will fail fast.
   *
   * @param {SlmodemBackend} backend — the just-used backend
   */
  recycle(backend) {
    if (this._stopped) {
      log.debug('recycle() on stopped pool — dropping backend');
      return;
    }
    if (this._state !== 'checked_out') {
      log.warn(`recycle() called in unexpected state ${this._state} — accepting anyway`);
    }
    this._state = 'empty';

    // Kick off the serialized stop-then-rewarm chain in the background.
    // We track the promise so stop() can wait for it — otherwise a
    // stop() issued while recycle is mid-flight would return while a
    // background warmup is still starting a fresh VM.
    this._recyclePromise = this._recycleAsync(backend)
      .catch(err => {
        log.error(`background warmup failed: ${err.message}`);
        this.emit('error', err);
      })
      .finally(() => { this._recyclePromise = null; });
  }

  /**
   * Internal helper: stop the old backend fully (so its TCP sockets
   * are released) and then kick off the warmup of a replacement.
   * @private
   */
  async _recycleAsync(backend) {
    // Stop the old backend. Always await — even if the caller already
    // called stop(), a second call is idempotent (it resolves quickly
    // if the VM is already dead).
    if (backend && typeof backend.stop === 'function') {
      try {
        const p = backend.stop();
        if (p && typeof p.then === 'function') await p;
      } catch (err) {
        log.debug(`recycle: backend.stop() rejected: ${err.message}`);
      }
    }
    // If the pool was stopped while we were awaiting the old stop,
    // don't bother booting a replacement.
    if (this._stopped) return;

    await this._warmupOne();
  }

  /**
   * Tear down the pool. Kills the warm backend if any. After stop(),
   * the pool cannot be started again (construct a new one instead).
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    log.info('Pool stopping');

    // If a warmup or recycle is in flight, let it finish (or fail)
    // so we can stop the result cleanly. The recycle chain internally
    // kicks off a warmup, so awaiting both in sequence covers every
    // background operation.
    if (this._recyclePromise) {
      try { await this._recyclePromise; } catch (_) { /* ignore */ }
    }
    if (this._warmupPromise) {
      try { await this._warmupPromise; } catch (_) { /* ignore */ }
    }

    if (this._backend) {
      const bk = this._backend;
      this._backend = null;
      try {
        const p = bk.stop();
        if (p && typeof p.then === 'function') await p;
      } catch (err) {
        log.debug(`stop: backend.stop() rejected: ${err.message}`);
      }
    }
    this._state = 'stopped';
    log.info('Pool stopped');
  }

  /**
   * Start a new backend and wait for it to reach ready state.
   * Transitions empty → warming → ready. On failure, transitions
   * back to empty and rejects.
   * @private
   */
  async _warmupOne() {
    if (this._state === 'warming' && this._warmupPromise) {
      return this._warmupPromise;
    }
    this._state = 'warming';

    this._warmupPromise = (async () => {
      const bk = new SlmodemBackend(this._backendOpts);
      // Attach an error listener BEFORE start so we don't trigger
      // Node's "unhandled 'error' event" crash if startAsync rejects
      // concurrently with a VM-level error emission.
      const errorListener = err => {
        // Errors during warmup are propagated via the rejected promise
        // below; we just need to absorb any concurrent emits so they
        // don't take down the process.
        log.debug(`warmup backend emitted error: ${err && err.message}`);
      };
      bk.on('error', errorListener);

      try {
        await Promise.race([
          bk.startAsync(),
          _timeoutRejection(this._warmupTimeoutMs, 'warmup'),
        ]);
      } catch (err) {
        // Try to stop the half-booted backend so it doesn't linger.
        try {
          const p = bk.stop();
          if (p && typeof p.then === 'function') await p;
        } catch (_) { /* ignore */ }
        bk.off('error', errorListener);
        this._state = 'empty';
        this._backend = null;
        this._warmupPromise = null;
        throw err;
      }

      // The error listener stays attached for the lifetime of the
      // backend — the caller's code in CallSession will also attach
      // one, and node allows multiple listeners.

      this._backend = bk;
      this._state = 'ready';
      this._warmupPromise = null;
      return bk;
    })();

    return this._warmupPromise;
  }
}

function _timeoutRejection(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(
      `ModemBackendPool: ${label} timed out after ${ms}ms`)), ms);
  });
}

module.exports = { ModemBackendPool };
