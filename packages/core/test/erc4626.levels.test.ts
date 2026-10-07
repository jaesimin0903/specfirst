import { describe, expect, it } from 'vitest';
import { propertiesHash } from '../src/attest/params.js';
import {
  ERC4626_CHECK_PROPERTIES,
  ERC4626_CHECK_PROPERTIES_V1,
  ERC4626_PROPERTY_LEVELS,
  erc4626PropertyLevel,
} from '../src/standards/erc4626.js';

/* The EIP-4626 level of each property, read against the EIP text, kept out of everything that is hashed. */

describe('ERC4626_PROPERTY_LEVELS', () => {
  it('covers exactly the 30 properties of both tables', () => {
    const ids = ERC4626_CHECK_PROPERTIES.map((p) => p.id);
    expect(Object.keys(ERC4626_PROPERTY_LEVELS).sort()).toEqual([...ids].sort());
    expect(ERC4626_CHECK_PROPERTIES_V1.map((p) => p.id)).toEqual(ids);
  });

  it('the round trips and the zero-allowance checks are SHOULDs, everything else a MUST', () => {
    const should = Object.entries(ERC4626_PROPERTY_LEVELS)
      .filter(([, v]) => v.level === 'should')
      .map(([id]) => id)
      .sort();
    expect(should).toEqual(
      [
        'RT-deposit-redeem',
        'RT-deposit-withdraw',
        'RT-mint-redeem',
        'RT-mint-withdraw',
        'RT-redeem-deposit',
        'RT-redeem-mint',
        'RT-withdraw-deposit',
        'RT-withdraw-mint',
        'redeem-zero-allowance',
        'withdraw-zero-allowance',
      ].sort(),
    );
    for (const [id, v] of Object.entries(ERC4626_PROPERTY_LEVELS)) {
      // Each quotes the EIP word its level stands for.
      expect(v.eip, id).toMatch(v.level === 'must' ? /MUST/ : /SHOULD|should/);
      if (v.level === 'must') expect(v.eip, id).not.toMatch(/^[^"]*"[^"]*SHOULD/);
    }
    expect(erc4626PropertyLevel('RT-redeem-mint')).toBe('should');
    expect(erc4626PropertyLevel('sf-maxRedeem-honored')).toBe('must');
    expect(erc4626PropertyLevel('test_unknown')).toBeNull();
  });

  it('touches nothing that is hashed: the table rows keep exactly id, test and description, and the hashes stay', () => {
    for (const p of [...ERC4626_CHECK_PROPERTIES, ...ERC4626_CHECK_PROPERTIES_V1]) expect(Object.keys(p).sort()).toEqual(['description', 'id', 'test']);
    expect(propertiesHash(ERC4626_CHECK_PROPERTIES_V1)).toBe('0x33117c4fed6c8e64829e6397d577a69153a43774fddd609e952264514e270204');
    expect(propertiesHash(ERC4626_CHECK_PROPERTIES)).toBe('0x7a2f06a57ed59d9c67aaf17b989e7d028c9346eb8d2679a5cc155f595667c5f5');
  });
});
