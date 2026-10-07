import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { createSharedEndpoint, isWindowsPipe, validateSharedEndpoint, prepareSharedEndpoint, removeSharedEndpoint } from '../src/platform/shared-endpoint.mjs';

test('Windows selects unpredictable native pipe names without filesystem sockets', () => {
  const first=createSharedEndpoint({platform:'win32'}),second=createSharedEndpoint({platform:'win32'});
  assert.equal(first.transport,'pipe');assert.equal(first.directory,null);assert.ok(isWindowsPipe(first.socket));assert.notEqual(first.socket,second.socket);
  assert.ok(validateSharedEndpoint(first,'win32'));
  assert.equal(validateSharedEndpoint({transport:'pipe',socket:'\\\\server\\pipe\\test'},'win32'),false);
  assert.equal(validateSharedEndpoint({transport:'pipe',socket:'\\\\.\\pipe\\guessable'},'win32'),false);
});

test('long macOS temporary roots fall back to a short socket path', {skip:process.platform==='win32'}, () => {
  const endpoint=createSharedEndpoint({platform:'darwin',temporaryRoot:'/unusable/'+ 'a'.repeat(160)});
  try { assert.ok(Buffer.byteLength(endpoint.socket)<100);assert.equal(endpoint.transport,'unix');assert.ok(existsSync(endpoint.directory)); }
  finally {removeSharedEndpoint(endpoint);}
});

test('native endpoint binds, passes validation, and releases its address', async () => {
  const endpoint=createSharedEndpoint();const server=net.createServer(s=>s.end());
  try {
    await new Promise((yes,no)=>{server.once('error',no);server.listen({path:endpoint.socket,readableAll:false,writableAll:false},yes);});
    prepareSharedEndpoint(endpoint);assert.ok(validateSharedEndpoint(endpoint));
    if (process.platform!=='win32') assert.equal(statSync(endpoint.socket).mode&0o777,0o600);
  }finally {await new Promise(yes=>server.close(yes));removeSharedEndpoint(endpoint);}
  const error = await new Promise(resolve => {
    const client = net.createConnection(endpoint.socket);
    client.once("error", resolve);
    client.once("connect", () => { client.destroy(); resolve(null); });
  });
  assert.ok(error, "closed endpoint must refuse new connections");
});
