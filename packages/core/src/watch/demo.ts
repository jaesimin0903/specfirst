// The watcher demo on a local chain or Monad testnet (docs/adr/0006): DemoVaultFactory at a fixed CREATE2
// address, so examples/watch/sources-demo.json can name it before it exists, DemoToken as the asset, and
// vaults deployed through the factory. Every write goes through the guarded wallet (never mainnet).
import { concat, getAddress, getContractAddress, parseEventLogs, toFunctionSelector, type Address, type Hex } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import type { TxOutcome } from '../cert/registry.js';
import { gasLimitFor } from '../deploy/deploy.js';
import { demoTokenAbi, demoTokenBytecode, demoVaultAbi, demoVaultFactoryAbi, demoVaultFactoryBytecode } from './demoArtifact.js';

export { demoTokenAbi, demoTokenBytecode, demoVaultAbi, demoVaultFactoryAbi, demoVaultFactoryBytecode };

/** The deterministic CREATE2 deployer (0x4e59...956c), present on Monad testnet, Monad mainnet and anvil. */
export const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const DEMO_FACTORY_SALT: Hex = `0x${'00'.repeat(32)}`;
/** Where DemoVaultFactory lives on every chain it is deployed to through CREATE2_DEPLOYER. */
export const DEMO_FACTORY_ADDRESS: Address = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: DEMO_FACTORY_SALT, bytecode: demoVaultFactoryBytecode });
/**
 * DemoVaultFactory as it was before DemoVault had setLoss: its bytecode embeds DemoVault's, so adding setLoss moved
 * the CREATE2 address. It stays deployed on Monad testnet and keeps announcing the vaults it makes (the demo sources
 * file lists both factories); its vaults have setBroken but no setLoss.
 */
export const LEGACY_DEMO_FACTORY_ADDRESS: Address = '0x27eFcf4d95B8AB853b31b65EFB3Adb1cAd93D432';

async function send(client: SpecfirstPublicClient, wallet: SpecfirstWalletClient, tx: { to?: Address; data: Hex }): Promise<TxOutcome & { contractAddress: Address | null; logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] }> {
  const gas = gasLimitFor(await client.estimateGas({ account: wallet.account.address, ...tx }));
  const hash = await wallet.sendTransaction({ ...tx, gas });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`demo transaction ${hash} reverted`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null, logs: receipt.logs };
}

/** Deploys DemoVaultFactory at DEMO_FACTORY_ADDRESS unless it is there already. */
export async function deployDemoFactory(i: { client: SpecfirstPublicClient; wallet: SpecfirstWalletClient }): Promise<{ address: Address; tx: TxOutcome | null }> {
  const code = await i.client.getCode({ address: DEMO_FACTORY_ADDRESS });
  if (code && code !== '0x') return { address: DEMO_FACTORY_ADDRESS, tx: null };
  const out = await send(i.client, i.wallet, { to: CREATE2_DEPLOYER, data: concat([DEMO_FACTORY_SALT, demoVaultFactoryBytecode]) });
  const after = await i.client.getCode({ address: DEMO_FACTORY_ADDRESS });
  if (!after || after === '0x') throw new Error(`CREATE2 deployment ${out.hash} left no code at ${DEMO_FACTORY_ADDRESS}`);
  return { address: DEMO_FACTORY_ADDRESS, tx: { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed } };
}

/** Deploys a DemoToken (anyone may mint it). */
export async function deployDemoToken(i: { client: SpecfirstPublicClient; wallet: SpecfirstWalletClient }): Promise<{ address: Address; tx: TxOutcome }> {
  const out = await send(i.client, i.wallet, { data: demoTokenBytecode });
  if (!out.contractAddress) throw new Error(`DemoToken deployment ${out.hash} has no contract address`);
  return { address: out.contractAddress, tx: { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed } };
}

/** Deploys a DemoVault over `asset` through the factory; the vault comes from the VaultDeployed event of the receipt. */
export async function deployDemoVault(i: {
  client: SpecfirstPublicClient;
  wallet: SpecfirstWalletClient;
  asset: Address;
  broken: boolean;
  factory?: Address;
}): Promise<{ vault: Address; tx: TxOutcome }> {
  const factory = i.factory ?? DEMO_FACTORY_ADDRESS;
  // Without code at the factory the call would "succeed" with no vault and no event: say so before sending.
  const code = await i.client.getCode({ address: factory });
  if (!code || code === '0x') throw new Error(`no DemoVaultFactory at ${factory} on this chain: deploy it first (specfirst watch demo deploy)`);
  const call = { address: factory, abi: demoVaultFactoryAbi, functionName: 'deploy', args: [i.asset, i.broken], account: i.wallet.account } as const;
  const gas = gasLimitFor(await i.client.estimateContractGas(call));
  const hash = await i.wallet.writeContract({ ...call, gas });
  const receipt = await i.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`DemoVaultFactory.deploy ${hash} reverted`);
  const events = parseEventLogs({ abi: demoVaultFactoryAbi, eventName: 'VaultDeployed', logs: receipt.logs }).filter((l) => l.address.toLowerCase() === factory.toLowerCase());
  if (events.length !== 1) throw new Error(`DemoVaultFactory.deploy ${hash}: expected one VaultDeployed event, found ${events.length}`);
  return { vault: getAddress(events[0]!.args.vault), tx: { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed } };
}

/** DemoVault.setBroken from the vault's operator: turns the deliberate previewDeposit bug on or off. */
export async function setDemoVaultBroken(i: { client: SpecfirstPublicClient; wallet: SpecfirstWalletClient; vault: Address; broken: boolean }): Promise<TxOutcome> {
  const call = { address: i.vault, abi: demoVaultAbi, functionName: 'setBroken', args: [i.broken], account: i.wallet.account } as const;
  const gas = gasLimitFor(await i.client.estimateContractGas(call));
  const hash = await i.wallet.writeContract({ ...call, gas });
  const receipt = await i.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`DemoVault.setBroken ${hash} reverted`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}

const SET_LOSS_SELECTOR = toFunctionSelector('setLoss(uint256)').slice(2);

/**
 * DemoVault.setLoss from the vault's operator: sends `bps` basis points (1 to 9,999) of its assets away, so the value
 * of a share falls by that fraction. A vault of the factory before setLoss (LEGACY_DEMO_FACTORY_ADDRESS) has no such
 * function; that is said before anything is sent. A loss that rounds to 0 base units changes nothing and is not sent
 * (`sent: false`); `assets` is what the LossSet event says left the vault.
 */
export async function setDemoVaultLoss(i: {
  client: SpecfirstPublicClient;
  wallet: SpecfirstWalletClient;
  vault: Address;
  bps: number;
}): Promise<({ sent: true } & TxOutcome & { assets: bigint }) | { sent: false; assets: 0n; totalAssets: bigint }> {
  if (!Number.isInteger(i.bps) || i.bps < 1 || i.bps > 9_999) throw new Error(`the loss must be 1 to 9999 basis points, got ${i.bps}`);
  const code = await i.client.getCode({ address: i.vault });
  if (!code || code === '0x') throw new Error(`no contract at ${i.vault}`);
  if (!code.toLowerCase().includes(SET_LOSS_SELECTOR)) {
    throw new Error(`${i.vault} has no setLoss: a DemoVault from the factory before setLoss (${LEGACY_DEMO_FACTORY_ADDRESS}); deploy a new one from ${DEMO_FACTORY_ADDRESS}`);
  }
  const totalAssets = (await i.client.readContract({ address: i.vault, abi: demoVaultAbi, functionName: 'totalAssets' })) as bigint;
  if ((totalAssets * BigInt(i.bps)) / 10_000n === 0n) return { sent: false, assets: 0n, totalAssets };
  const call = { address: i.vault, abi: demoVaultAbi, functionName: 'setLoss', args: [BigInt(i.bps)], account: i.wallet.account } as const;
  const gas = gasLimitFor(await i.client.estimateContractGas(call));
  const hash = await i.wallet.writeContract({ ...call, gas });
  const receipt = await i.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`DemoVault.setLoss ${hash} reverted`);
  const [lost] = parseEventLogs({ abi: demoVaultAbi, eventName: 'LossSet', logs: receipt.logs }).filter((l) => l.address.toLowerCase() === i.vault.toLowerCase());
  return { sent: true, hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, assets: lost?.args.assets ?? 0n };
}

/** Mints `amount` DemoToken to the wallet, approves the vault and deposits it (a first deposit for the demo). */
export async function depositIntoDemoVault(i: { client: SpecfirstPublicClient; wallet: SpecfirstWalletClient; vault: Address; asset: Address; amount: bigint }): Promise<TxOutcome> {
  const me = i.wallet.account.address;
  const write = async (address: Address, abi: typeof demoTokenAbi | typeof demoVaultAbi, functionName: string, args: readonly unknown[]): Promise<TxOutcome> => {
    const call = { address, abi, functionName, args, account: i.wallet.account } as never;
    const gas = gasLimitFor(await i.client.estimateContractGas(call));
    const hash = await i.wallet.writeContract({ ...(call as object), gas } as never);
    const receipt = await i.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} ${hash} reverted`);
    return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  };
  await write(i.asset, demoTokenAbi, 'mint', [me, i.amount]);
  await write(i.asset, demoTokenAbi, 'approve', [i.vault, i.amount]);
  return write(i.vault, demoVaultAbi, 'deposit', [i.amount, me]);
}
