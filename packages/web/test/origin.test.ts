import { describe, expect, it } from 'vitest';
import { publicOrigin } from '../lib/origin';

describe('publicOrigin', () => {
  it('is the request origin without SPECFIRST_PUBLIC_ORIGIN', () => {
    expect(publicOrigin('http://localhost:3000/api/v1/vaults/143/0xabc', {})).toBe('http://localhost:3000');
    expect(publicOrigin('https://specfirst.test/x?y=1', { SPECFIRST_PUBLIC_ORIGIN: '  ' })).toBe('https://specfirst.test');
  });

  it('takes SPECFIRST_PUBLIC_ORIGIN behind a proxy, as an origin only', () => {
    const env = { SPECFIRST_PUBLIC_ORIGIN: 'https://specfirst.example.org/' };
    expect(publicOrigin('http://localhost:3000/api/v1/vaults/143/0xabc', env)).toBe('https://specfirst.example.org');
    expect(publicOrigin('http://localhost:3000/', { SPECFIRST_PUBLIC_ORIGIN: 'https://specfirst.example.org:8443/path?q' })).toBe('https://specfirst.example.org:8443');
  });

  it('ignores a value that is not an http(s) URL', () => {
    expect(publicOrigin('http://localhost:3000/', { SPECFIRST_PUBLIC_ORIGIN: 'specfirst.example.org' })).toBe('http://localhost:3000');
    expect(publicOrigin('http://localhost:3000/', { SPECFIRST_PUBLIC_ORIGIN: 'javascript:alert(1)' })).toBe('http://localhost:3000');
  });
});
