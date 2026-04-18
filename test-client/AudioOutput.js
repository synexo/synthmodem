'use strict';

/**
 * AudioOutput
 *
 * Optional speaker playback of modem audio.
 * Uses the 'speaker' npm package (wraps PortAudio, cross-platform).
 *
 * Falls back gracefully if 'speaker' is not installed.
 *
 * Receives Float32Array @ 8000 Hz, converts to signed 16-bit PCM for speaker.
 * Uses a bounded queue to avoid buffer overflow — excess frames are dropped.
 */

const { EventEmitter } = require('events');
const config           = require('../config');
const { makeLogger }   = require('../src/logger');

const log = makeLogger('AudioOut');
const tc  = config.testClient;

// Max number of 20ms frames to queue before dropping (2 seconds of audio)
const MAX_QUEUE = 100;

class AudioOutput extends EventEmitter {

  constructor() {
    super();
    this._speaker       = null;
    this._available     = false;
    this._volume        = tc.audioOutputVolume;
    this._sampleRate    = config.rtp.sampleRate;
    this._droppedFrames = 0;
    this._queue         = [];   // Buffer[] waiting to be written
    this._writing       = false;
  }

  async init() {
    if (!tc.audioOutput) {
      log.debug('Audio output disabled in config');
      return false;
    }

    try {
      const Speaker = require('speaker');
      this._speaker = new Speaker({
        channels:   1,
        bitDepth:   16,
        sampleRate: this._sampleRate,
        signed:     true,
      });

      this._speaker.on('error', err => {
        log.warn(`Speaker error: ${err.message}`);
        this._available = false;
      });

      this._speaker.on('close', () => {
        log.debug('Speaker closed');
        this._available = false;
      });

      // Use drain event for backpressure
      this._speaker.on('drain', () => {
        this._writing = false;
        this._flush();
      });

      this._available = true;
      log.info(`Audio output active — ${this._sampleRate} Hz, 16-bit mono`);
      return true;
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        log.warn('speaker module not found — run: npm install speaker');
      } else {
        log.warn(`Failed to initialise audio output: ${err.message}`);
      }
      this._available = false;
      return false;
    }
  }

  /**
   * Push Float32Array samples to speaker output.
   * Drops frames silently if the queue is full.
   */
  push(samples) {
    if (!this._available || !this._speaker) return;

    if (this._queue.length >= MAX_QUEUE) {
      this._droppedFrames++;
      // Log only at milestones to avoid spam
      if (this._droppedFrames === 1 || this._droppedFrames % 500 === 0) {
        log.debug(`Audio queue full — dropped ${this._droppedFrames} frames total`);
      }
      return;
    }

    // Convert Float32 → Int16 LE PCM with volume
    const vol = Math.max(0, Math.min(1, this._volume));
    const pcm = Buffer.allocUnsafe(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i] * vol));
      const v = s < 0 ? s * 32768 : s * 32767;
      pcm.writeInt16LE(Math.round(v), i * 2);
    }

    this._queue.push(pcm);
    if (!this._writing) this._flush();
  }

  _flush() {
    if (!this._available || !this._speaker || this._queue.length === 0) return;
    const buf = this._queue.shift();
    this._writing = true;
    const ok = this._speaker.write(buf);
    // If write returns false, backpressure — wait for drain event
    if (ok) {
      this._writing = false;
      // Write more if we have queued data, but yield to event loop
      if (this._queue.length > 0) {
        setImmediate(() => this._flush());
      }
    }
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
  }

  close() {
    this._queue = [];
    if (this._speaker) {
      try { this._speaker.end(); } catch (_) {}
      this._speaker = null;
    }
    this._available = false;
  }

  get available() { return this._available; }
  get volume()    { return this._volume; }
}

module.exports = { AudioOutput };
