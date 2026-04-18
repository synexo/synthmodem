#!/usr/bin/env node
/**
 * QAM loopback runner — executed as a child process so it starts with
 * a completely clean module cache, free from contamination by prior tests.
 * Usage: node test/loopback_qam.js <protocol>
 * Exits 0 on pass, 1 on fail.
 */
'use strict';
const proto = process.argv[2] || 'V22bis';
const banner = Buffer.from('\r\n  SynthModem\r\n\r\nCONNECT> ');

let TxCls;
if      (proto === 'V22bis') ({ V22bis: TxCls } = require('../src/dsp/protocols/V22'));
else if (proto === 'V32bis') ({ V32bis: TxCls } = require('../src/dsp/protocols/V32bis'));
else if (proto === 'V34')    ({ V34:    TxCls } = require('../src/dsp/protocols/V34'));
else    { console.error('Unknown: ' + proto); process.exit(1); }

const tx = new TxCls('answer'), rx = new TxCls('originate'), got = [];
if (proto === 'V34') { tx._dataMode = true; rx._dataMode = true; }
rx.on('data', b => got.push(...b));
rx.receiveAudio(tx.generateAudio(8000));
tx.write(banner);
rx.receiveAudio(tx.generateAudio(20000));
const text = got.map(b => b>31&&b<127?String.fromCharCode(b):(b===13||b===10?'↵':'.')).join('');
const pass = text.includes('SynthModem') || text.includes('CONNECT');
process.stdout.write(pass ? 'PASS\n' : 'FAIL: '+text.slice(0,30)+'\n');
process.exit(pass ? 0 : 1);
