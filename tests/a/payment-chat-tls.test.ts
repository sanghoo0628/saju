import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paymentChatTls } from '../../src/server/payment-chat-tls';
import { ConfigurationError } from '../../src/lib/env/schema';
import { rootCertificates } from 'node:tls';

test('Supabase direct and pooler URLs require an explicit CA file', () => {
  for(const host of ['aws-1-ap-southeast-1.pooler.supabase.com','db.project.supabase.co']) {
    assert.throws(()=>paymentChatTls(`postgresql://user:fake@${host}:6543/postgres`),error=>error instanceof ConfigurationError && error.fields.includes('DATABASE_SSL_CA_PATH/DATABASE_SSL_CA_PEM'));
  }
});

test('cloud deployments can use an inline CA without a machine-specific file path', () => {
  const pem=rootCertificates[0]!;
  assert.deepEqual(paymentChatTls('postgresql://user@project.pooler.supabase.com/db','/not-on-cloud/ca.crt',pem),{rejectUnauthorized:true,ca:pem.trim()});
  assert.deepEqual(paymentChatTls('postgresql://user@project.pooler.supabase.com/db',undefined,pem.replace(/\n/g,'\\n')),{rejectUnauthorized:true,ca:pem.trim()});
});

test('a malformed inline CA fails without exposing its contents or falling back', () => {
  assert.throws(()=>paymentChatTls('postgresql://user@project.pooler.supabase.com/db',undefined,'private-invalid-CA'),error=>error instanceof ConfigurationError && !error.message.includes('private-invalid-CA'));
});

test('explicit CA keeps certificate verification on and never falls back when unreadable', () => {
  const dir=mkdtempSync(join(tmpdir(),'saju-ca-test-'));
  try {
    const path=join(dir,'ca.crt');writeFileSync(path,'public test CA');
    assert.deepEqual(paymentChatTls('postgresql://user@project.pooler.supabase.com/db',path),{rejectUnauthorized:true,ca:'public test CA'});
    assert.throws(()=>paymentChatTls('postgresql://user@project.pooler.supabase.com/db',join(dir,'missing.crt')),{code:'ENOENT'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('other PostgreSQL servers retain Node trusted roots with strict verification', () => {
  assert.deepEqual(paymentChatTls('postgresql://user@db.example.test/db'),{rejectUnauthorized:true});
});
