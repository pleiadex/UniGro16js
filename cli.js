/* eslint-disable no-console */

import clProcessor from './src/clprocessor.js';
import * as zkey from './src/zkey.js';
import Logger from 'logplease';
const logger = Logger.create('UniGro16js', {showTimestamp: false});
Logger.setLogLevel('INFO');

const commands = [
  {
    cmd: 'setup [paramName] [RSName] [QAPName]',
    description: 'setup phase',
    alias: ['st'],
    options: "-verbose|v",
    action: setup,
  },
  {
    cmd: 'derive [RSName] [cRSName] [circuitName] [QAPName]',
    description: 'derive phase',
    alias: ['dr'],
    options: "-verbose|v",
    action: derive,
  },
  {
    cmd: 'prove [cRSName] [proofName] [circuitName] [instanceId]',
    description: 'prove phase',
    alias: ['pr'],
    options: "-verbose|v",
    action: groth16Prove,
  },
  {
    cmd: 'verify [proofName] [cRSName] [circuitName] [instanceId]',
    description: 'verify phase',
    alias: ['vr'],
    options: "-verbose|v",
    action: groth16Verify,
  },
  {
    cmd: 'qap-all [curveName] [s_D] [min_s_max]',
    description: 'build all qap',
    alias: ['qa'],
    options: "-verbose|v",
    action: buildQAP,
  },
  {
    cmd: 'qap-single [paramName] [id]',
    description: 'build a single qap',
    alias: ['qs'],
    options: "-verbose|v",
    action: buildSingleQAP,
  },
];

clProcessor(commands).then( (res) => {
  process.exit(res);
}, (err) => {
  logger.error(err);
  process.exit(1);
});

async function buildQAP(params, options) {
  const curveName = params[0];
  const sD = params[1];
  const minSMax = params[2];

  if (options.verbose) Logger.setLogLevel("DEBUG");

  return zkey.buildQAP(curveName, sD, minSMax, logger);
}
async function buildSingleQAP(params, options) {
  const paramName = params[0];
  const id = params[1];

  if (options.verbose) Logger.setLogLevel("DEBUG");

  return zkey.buildSingleQAP(paramName, id, logger);
}
async function setup(params, options) {
  const paramName = params[0];
  const RSName = params[1];
  const QAPName = params[2];

  if (options.verbose) Logger.setLogLevel("DEBUG");

  return zkey.setup(paramName, RSName, QAPName, logger);
}
async function derive(params, options) {
  const RSName = params[0];
  const cRSName = params[1];
  const circuitName = params[2];
  const QAPName = params[3];

  if (options.verbose) Logger.setLogLevel("DEBUG");

  return zkey.derive(RSName, cRSName, circuitName, QAPName, logger);
}
async function groth16Prove(params, options) {
  const cRSName = params[0];
  const proofName = params[1];
  const circuitName = params[2];
  const instanceId = params[3];

  if (options.verbose) Logger.setLogLevel("DEBUG");

  return zkey.groth16Prove(cRSName, proofName, circuitName, instanceId, logger);
}
async function groth16Verify(params, options) {
  const proofName = params[0];
  const cRSName = params[1];
  const circuitName = params[2];
  const instanceId = params[3] || '1';

  if (options.verbose) Logger.setLogLevel("DEBUG");
  
  const isValid = await zkey.groth16Verify(proofName, cRSName, circuitName, instanceId, logger);
  if (isValid === true) {
    console.log('VALID')
  } else {
    console.log('INVALID')
  }
}