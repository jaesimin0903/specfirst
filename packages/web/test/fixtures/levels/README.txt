Check reports for the EIP-4626 level tests (test/board-levels-view.test.tsx), derived from the Steakhouse fixture of
test/fixtures/board/checks with results changed by hand. Synthetic, not real check output. Round-trip logs follow
upstream assertApproxLeAbs / assertApproxGeAbs ("Value a", "Value b", "Max Delta", "Delta"); withdraw and redeem
reasons follow forge's messages ("access control", "allowance: a !~= b (...)", "share: ...").
  0xb464... tyYIELD: three round trips off by 1 base unit (rounding favors the caller).
  0x9999... previewDeposit (a MUST) next to a round trip.
  0x1000...01 withdraw with reason "access control", as a view the vault calls reverting with that text leaves it:
              a MUST, since the vault can write that text.
  0x1000...02 redeem with an "allowance" assertion reason: a MUST as well.
  0x1000...03 withdraw fails "share" (a MUST).
  0x1000...04 a round trip off by 5% of the amount (a SHOULD, but more than rounding).
  0x1000...05 a round trip whose logs do not give the size.
  0x1000...06 a round trip whose vault wrote a 1-unit "Value a / Value b" pair with console.log before the real
              assertion, which is off by 4,000,000: judged by every pair, so not rounding.
  0x1000...07 a vault that only skips the allowance check: withdraw-zero-allowance fails, a SHOULD.
