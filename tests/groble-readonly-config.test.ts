import { afterEach, expect, it, vi } from 'vitest';
import { validateGrobleProbeTarget, runGrobleReadonly } from '../scripts/verify-groble-readonly';
const ref='acghfykdtorpxkbmknja';
const url=`postgresql://postgres.${ref}:fixture-password@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const config={C_GROBLE_READONLY_PROJECT_REF:ref,DATABASE_URL:url};
afterEach(()=>vi.restoreAllMocks());
it('requires an explicitly matching project for the pooler URL',()=>{
  expect(validateGrobleProbeTarget(config)).toBe(url);
  expect(()=>validateGrobleProbeTarget({...config,C_GROBLE_READONLY_PROJECT_REF:'a'.repeat(20)})).toThrow();
});
it('direct connections bind the project hostname and postgres username',()=>{
  const direct=`postgresql://postgres:fixture-password@db.${ref}.supabase.co/postgres`;
  expect(validateGrobleProbeTarget({...config,DATABASE_URL:direct})).toBe(direct);
});
for(const query of ['sslmode=disable','ssl=0','host=other.example','user=other','uselibpqcompat=true','sslrootcert=/tmp/other'])
  it('refuses URL query overrides: '+query.split('=')[0],()=>{
    expect(()=>validateGrobleProbeTarget({...config,DATABASE_URL:url+'?'+query})).toThrow();
  });
for(const source of [{},{DATABASE_URL:url},{...config,DATABASE_URL:'https://example.invalid'},
  {...config,DATABASE_URL:url.replace('pooler.supabase.com','pooler.supabase.com.evil.invalid')},
  {...config,DATABASE_URL:url+'#unexpected'}])it('invalid target fails without exposing the supplied connection string',()=>{
    expect(()=>validateGrobleProbeTarget(source)).toThrow();
  });
it('invalid configuration prints only bounded diagnostics without connecting',async()=>{
  const out=vi.spyOn(console,'log').mockImplementation(()=>{}),err=vi.spyOn(console,'error').mockImplementation(()=>{});
  expect(await runGrobleReadonly({DATABASE_URL:'PRIVATE-CONNECTION-STRING',GROBLE_WEBHOOK_SECRET:'PRIVATE-SECRET'})).toBe(1);
  expect(out).not.toHaveBeenCalled();
  expect(err).toHaveBeenCalledTimes(1);const line=String(err.mock.calls[0]![0]);
  expect(line).not.toContain('PRIVATE');expect(JSON.parse(line)).toMatchObject({databaseReady:false,phase:'configuration_or_connection'});
});
