import { Logger } from '@btc-vision/logger';
import { networks, type Network } from '@btc-vision/bitcoin';
import { Mnemonic, type Wallet } from '@btc-vision/transaction';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
    getContract,
    JSONRpcProvider,
    type TransactionParameters,
    type UTXO,
    type InteractionTransactionReceipt,
} from 'opnet';
import type { BridgeService } from './bridge.js';
import {
    ORDINALS_BRIDGE_NFT_ABI,
    type IOrdinalsBridgeNFTContract,
} from './bridge-abi.js';
import type { BurnClaim } from './types.js';

/**
 * Maximum attestations to process per cycle.
 * Stays under the Bitcoin mempool chain limit of 25 unconfirmed.
 */
const MAX_BATCH_SIZE = 20;

/**
 * Default polling interval in milliseconds.
 */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Automatic attestation worker.
 *
 * Polls for confirmed burn claims and submits `attestBurn()` transactions
 * to the OP721 contract using the deployer wallet.
 */
export class AttestationWorker {
    private readonly logger: Logger = new Logger();
    private readonly bridge: BridgeService;
    private readonly provider: JSONRpcProvider;
    private readonly network: Network;
    private readonly contractAddress: string;
    private readonly wallet: Wallet;
    private readonly pollIntervalMs: number;

    /** UTXOs chained between successive attestations within a cycle. */
    private pendingUtxos: UTXO[] = [];

    public constructor(
        bridge: BridgeService,
        rpcUrl: string,
        networkName: 'mainnet' | 'testnet' | 'regtest',
        contractAddress: string,
        deployerMnemonic: string,
        pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    ) {
        this.bridge = bridge;
        this.contractAddress = contractAddress;
        this.pollIntervalMs = pollIntervalMs;

        this.network = this.resolveNetwork(networkName);
        this.provider = new JSONRpcProvider(rpcUrl, this.network);

        // Derive deployer wallet from mnemonic
        const mnemonic = new Mnemonic(deployerMnemonic, '', this.network);
        this.wallet = mnemonic.deriveOPWallet();

        this.logger.info(
            `AttestationWorker initialized — contract: ${contractAddress}, ` +
            `deployer: ${this.wallet.p2tr}`,
        );
    }

    /**
     * Process all confirmed claims in a single cycle.
     * Called by the plugin after block processing.
     */
    public async processConfirmedClaims(): Promise<number> {
        const claims = await this.bridge.getClaimsReadyForAttestation();
        if (claims.length === 0) {
            return 0;
        }

        const batch = claims.slice(0, MAX_BATCH_SIZE);
        this.logger.info(`Processing ${batch.length} confirmed claim(s) for attestation`);

        let processed = 0;

        for (const claim of batch) {
            try {
                await this.attestClaim(claim);
                processed++;
            } catch (error) {
                this.logger.error(
                    `Failed to attest claim ${claim.inscriptionId}: ${String(error)}`,
                );
                await this.bridge.markFailed(claim.inscriptionId);
            }
        }

        return processed;
    }

    /**
     * Get the polling interval for the worker loop.
     */
    public getPollIntervalMs(): number {
        return this.pollIntervalMs;
    }

    /**
     * Compute the keccak256 hash of an inscription ID, returned as a bigint.
     */
    public static computeInscriptionHash(inscriptionId: string): bigint {
        const bytes = new TextEncoder().encode(inscriptionId);
        const hash = keccak_256(bytes);
        // Convert 32-byte hash to bigint (big-endian)
        let result = 0n;
        for (let i = 0; i < hash.length; i++) {
            result = (result << 8n) | BigInt(hash[i]);
        }
        return result;
    }

    /**
     * Submit an attestBurn transaction for a single claim.
     */
    private async attestClaim(claim: BurnClaim): Promise<void> {
        const contract = getContract<IOrdinalsBridgeNFTContract>(
            this.contractAddress,
            ORDINALS_BRIDGE_NFT_ABI,
            this.provider,
            this.network,
            this.wallet.address,
        );

        const inscriptionHash = AttestationWorker.computeInscriptionHash(claim.inscriptionId);
        const tokenId = BigInt(claim.tokenId);

        this.logger.debug(
            `Attesting: inscription=${claim.inscriptionId} hash=${inscriptionHash} ` +
            `tokenId=${tokenId} to=${claim.senderAddress}`,
        );

        // Simulate the attestBurn call
        const simulation = await contract.attestBurn(
            this.wallet.address,
            inscriptionHash,
            tokenId,
        );

        if (simulation.revert) {
            this.logger.error(
                `attestBurn reverted for ${claim.inscriptionId}: ${simulation.revert}`,
            );
            await this.bridge.markFailed(claim.inscriptionId);
            return;
        }

        // Build transaction parameters
        const txParams: TransactionParameters = {
            signer: this.wallet.keypair,
            mldsaSigner: this.wallet.mldsaKeypair,
            refundTo: this.wallet.p2tr,
            maximumAllowedSatToSpend: 100_000n,
            feeRate: 0,
            network: this.network,
            priorityFee: 0n,
            ...(this.pendingUtxos.length > 0 ? { utxos: this.pendingUtxos } : {}),
        };

        // Send the transaction
        const receipt: InteractionTransactionReceipt = await simulation.sendTransaction(txParams);

        // Chain UTXOs for the next attestation
        if (receipt.newUTXOs && receipt.newUTXOs.length > 0) {
            this.pendingUtxos = receipt.newUTXOs;
        }

        // Mark claim as attested
        await this.bridge.markAttested(claim.inscriptionId, receipt.transactionId);

        this.logger.info(
            `Attested: ${claim.inscriptionId} -> tx ${receipt.transactionId}`,
        );
    }

    private resolveNetwork(name: 'mainnet' | 'testnet' | 'regtest'): Network {
        switch (name) {
            case 'mainnet': return networks.bitcoin;
            case 'testnet': return networks.testnet;
            case 'regtest': return networks.regtest;
            default: throw new Error(`Unknown network: ${String(name)}`);
        }
    }
}
