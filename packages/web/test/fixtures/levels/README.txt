Two check reports for the EIP-4626 level tests (test/board-levels.test.tsx), derived from the Steakhouse fixture
of test/fixtures/board/checks with results changed by hand: 0xb464... (tyYIELD) fails only three round trips by
one base unit, as its Aave wrapper rounds in the caller's favor; 0x9999... fails previewDeposit (a MUST) and one
round trip. Synthetic, not real check output.
