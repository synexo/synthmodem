'use strict';

/**
 * ModemEmulator
 *
 * Virtual originating modem for the test client.
 * Mirrors ModemDSP but operates in 'originate' role:
 *  - Sends CI tones to trigger V.8 negotiation
 *  - Detects ANSam from the answering modem
 *  - Completes handshake
 *  - Provides a simple data interface once connected
 *
 * Also supports 'forceProtocol' to bypass V.8 for direct testing.
 */

const { EventEmitter }    = require('events');
const config              = require('../config');
const { makeLogger }      = require('../src/logger');
const { ModemDSP }        = require('../src/dsp/ModemDSP');

const log = makeLogger('ModemEmulator');

class ModemEmulator extends EventEmitter {

  constructor() {
    super();
    // Force originate role for the test client
    this._dsp = new ModemDSP('originate');

    this._dsp.on('connected', info => {
      log.info(`Modem emulator connected: ${info.protocol} @ ${info.bps} bps`);
      this.emit('connected', info);
    });

    this._dsp.on('data', buf => {
      this.emit('data', buf);
    });

    this._dsp.on('audioOut', samples => {
      this.emit('audioOut', samples);
    });

    this._dsp.on('silenceHangup', () => {
      log.warn('Silence hangup in emulator');
      this.emit('silenceHangup');
    });
  }

  start() {
    log.debug('ModemEmulator starting (originate mode)');
    this._dsp.start();
  }

  stop() {
    this._dsp.stop();
  }

  /** Feed received RTP audio into the modem DSP */
  receiveAudio(samples) {
    this._dsp.receiveAudio(samples);
  }

  /** Write data bytes to be transmitted once connected */
  write(data) {
    this._dsp.write(data);
  }

  get connected() { return this._dsp.connected; }
  get protocol()  { return this._dsp.protocol; }
  get state()     { return this._dsp.handshakeState; }
}

module.exports = { ModemEmulator };
