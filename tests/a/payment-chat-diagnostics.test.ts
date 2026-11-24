import assert from 'node:assert/strict';
import test from 'node:test';
import { logPaymentChatError } from '../../src/server/payment-chat-diagnostics';

test('unexpected error diagnostics contain only allowlisted names and codes', () => {
  const entries: unknown[]=[];
  const error=Object.assign(new Error('private message https://private.example/?secret=fake'),{code:'23505',query:'private query',detail:'private detail'});
  logPaymentChatError('request',error,entry=>entries.push(entry));
  assert.deepEqual(entries,[{event:'payment_chat_unexpected_error',phase:'request',name:'Error',code:'23505'}]);
  assert.doesNotMatch(JSON.stringify(entries),/private|secret|query|detail/);
});

test('arbitrary error identifiers and throwing sinks cannot expose data or break requests', () => {
  let entry: unknown;
  logPaymentChatError('runtime',{name:'private@example.test',code:'PRIVATE_SECRET'},value=>{entry=value;});
  assert.deepEqual(entry,{event:'payment_chat_unexpected_error',phase:'runtime',name:'UnknownError',code:'UNREPORTED'});
  assert.doesNotThrow(()=>logPaymentChatError('request',new Error(),()=>{throw new Error('sink failure');}));
});

test('throwing accessors also produce bounded diagnostics', () => {
  let entry: unknown;
  logPaymentChatError('runtime',{get name(){throw new Error('private');}},value=>{entry=value;});
  assert.deepEqual(entry,{event:'payment_chat_unexpected_error',phase:'runtime',name:'UnknownError',code:'UNREPORTED'});
});

test('configuration diagnostics identify the class without listing missing keys', async () => {
  const {ConfigurationError}=await import('../../src/lib/env/schema');
  let entry: unknown;
  logPaymentChatError('runtime',new ConfigurationError(['PRIVATE_KEY_NAME']),value=>{entry=value;});
  assert.deepEqual(entry,{event:'payment_chat_unexpected_error',phase:'runtime',name:'ConfigurationError',code:'CONFIGURATION_ERROR'});
  assert.doesNotMatch(JSON.stringify(entry),/PRIVATE_KEY_NAME/);
});
