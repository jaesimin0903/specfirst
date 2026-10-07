Check reports for the EIP-4626 level tests (test/board-levels-view.test.tsx), derived from the Steakhouse fixture of
test/fixtures/board/checks with results changed by hand. Synthetic, not real check output. Round-trip logs follow
upstream assertApproxLeAbs / assertApproxGeAbs ("Value a", "Value b", "Max Delta", "Delta"); withdraw and redeem
reasons follow forge-std's assertion messages ("access control", "allowance: a !~= b (...)", "share: ...").
  0xb464... tyYIELD: three round trips off by 1 base unit (rounding favors the caller).
  0x9999... previewDeposit (a MUST) next to a round trip.
  0x1000...01 withdraw fails "access control" (a SHOULD: the vault skips the allowance check).
  0x1000...02 redeem fails "allowance" (a SHOULD: it does not spend the allowance).
  0x1000...03 withdraw fails "share" (a MUST: wrong shares burned).
  0x1000...04 a round trip off by 5% of the amount (a SHOULD, but more than rounding).
  0x1000...05 a round trip whose logs do not give the size.
