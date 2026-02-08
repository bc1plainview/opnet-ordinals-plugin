import { Logger } from '@btc-vision/logger';
import {
    getContract,
    JSONRpcProvider,
    type TransactionParameters,
    type InteractionTransactionReceipt,
} from 'opnet';
import {
    Address,
    AddressTypes,
    Mnemonic,
    type UTXO,
} from '@btc-vision/transaction';
import { address as btcAddress, networks, type Network } from '@btc-vision/bitcoin';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BridgeService } from './bridge.js';
import type { BurnClaim } from './types.js';
import {
    ORDINALS_BRIDGE_NFT_ABI,
    type IOrdinalsBridgeNFTContract,
} from './bridge-abi.js';

/**
 * Maximum attestations per block cycle to avoid hitting Bitcoin's
 * 25-unconfirmed-ancestor chain limit.
 */
const MAX_ATTESTATIONS_PER_CYCLE = 20;

/**
 * Maximum sats the worker is willing to spend per attestation.
 * Acts as a safety cap in case fee estimation is unexpectedly high.
 */
const MAX_SATS_PER_ATTESTATION = 100_000n;

/**
 * Attestation worker — automatically submits attestBurn() transactions
 * for confirmed burn claims.
 *
 * Lifecycle per block cycle:
 *   1. Poll BridgeService for claims with status "confirmed"
 *   2. For each claim: simulate attestBurn → sign → broadcast
 *   3. Chain UTXOs between transactions within a cycle
 *   4. Mark claims as "attested" or "failed"
 */
export class AttestationWorker {
    private readonly logger: Logger = new Logger();
    private readonly bridge: BridgeService;
    private readonly provider: JSONRpcProvider;
    private readonly network: Network;
    private readonly contractAddress: string;
    private contract: IOrdinalsBridgeNFTContract | null = null;

    // Wallet derived from deployer mnemonic
    private readonly wallet: ReturnType<Mnemonic['deriveOPWallet']>;

    // UTXO tracking: chain change outputs between attestations
    private pendingUtxos: UTXO[] | undefined;

    public constructor(
        bridge: BridgeService,
        rpcUrl: string,
        networkName: string,
        contractAddress: string,
        deployerMnemonic: string,
    ) {
        this.bridge = bridge;
        this.contractAddress = contractAddress;
        this.network = AttestationWorker.resolveNetwork(networkName);
        this.provider = new JSONRpcProvider(rpcUrl, this.network);

        // Derive deployer wallet from mnemonic (OPWallet-compatible derivation)
        const mnemonic = new Mnemonic(deployerMnemonic, '', this.network);
        this.wallet = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);

        this.logger.info(
            `Attestation worker initialized (deployer: ${this.wallet.p2tr})`,
        );
    }

    /**
     * Process all confirmed claims, submit attestBurn transactions, and
     * return the number of successfully attested claims.
     */
    public async processConfirmedClaims(): Promise<number> {
        const claims = await this.bridge.getClaimsReadyForAttestation();
        if (claims.length === 0) return 0;

        // Lazily initialize contract instance
        if (this.contract === null) {
            this.contract = getContract<IOrdinalsBridgeNFTContract>(
                this.contractAddress,
                ORDINALS_BRIDGE_NFT_ABI,
                this.provider,
                this.network,
                this.wallet.address,
            );
        }

        const batch = claims.slice(0, MAX_ATTESTATIONS_PER_CYCLE);
        let attested = 0;

        for (const claim of batch) {
            try {
                const success = await this.attestClaim(claim);
                if (success) attested++;
            } catch (error) {
                this.logger.error(
                    `Attestation failed for ${claim.inscriptionId}: ${String(error)}`,
                );
                await this.bridge.markFailed(claim.inscriptionId);
            }
        }

        return attested;
    }

    /**
     * Hash an inscription ID string to a u256 for the contract.
     * Uses keccak256 and returns the hash as a bigint.
     */
    public static hashInscriptionId(inscriptionId: string): bigint {
        const hash = keccak_256(new TextEncoder().encode(inscriptionId));
        return BigInt('0x' + bytesToHex(hash));
    }

    /**
     * Convert a bech32/bech32m Bitcoin address to an OPNet Address.
     *
     * For p2tr addresses the witness program IS the 32-byte x-only pubkey,
     * which can be used directly as an OPNet Address via Address.wrap().
     */
    public static bech32ToAddress(bech32Addr: string): Address {
        const decoded = btcAddress.fromBech32(bech32Addr);
        return Address.wrap(decoded.data);
    }

    /**
     * Get the deployer's p2tr address (useful for diagnostics / logging).
     */
    public getDeployerAddress(): string {
        return this.wallet.p2tr;
    }

    // ---------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------

    private async attestClaim(claim: BurnClaim): Promise<boolean> {
        if (this.contract === null) return false;

        const inscriptionHash = AttestationWorker.hashInscriptionId(claim.inscriptionId);
        const tokenId = BigInt(claim.tokenId);

        // Convert the sender's bech32 address to an OPNet Address
        let recipientAddress: Address;
        try {
            recipientAddress = AttestationWorker.bech32ToAddress(claim.senderAddress);
        } catch {
            this.logger.error(
                `Cannot convert sender address "${claim.senderAddress}" to OPNet Address ` +
                `(only bech32/bech32m addresses are supported)`,
            );
            await this.bridge.markFailed(claim.inscriptionId);
            return false;
        }

        // Step 1: Simulate
        this.logger.debug(
            `Simulating attestBurn for ${claim.inscriptionId} ` +
            `(token #${claim.tokenId}, to: ${claim.senderAddress})`,
        );

        const simulation = await this.contract.attestBurn(
            recipientAddress,
            inscriptionHash,
            tokenId,
        );

        if (simulation.revert) {
            this.logger.error(
                `attestBurn reverted for ${claim.inscriptionId}: ${simulation.revert}`,
            );
            await this.bridge.markFailed(claim.inscriptionId);
            return false;
        }

        // Step 2: Build transaction params
        const params: TransactionParameters = {
            signer: this.wallet.keypair,
            mldsaSigner: this.wallet.mldsaKeypair,
            refundTo: this.wallet.p2tr,
            maximumAllowedSatToSpend: MAX_SATS_PER_ATTESTATION,
            feeRate: 0,
            network: this.network,
            utxos: this.pendingUtxos,
        };

        // Step 3: Send
        let receipt: InteractionTransactionReceipt;
        try {
            receipt = await simulation.sendTransaction(params);
        } catch (error) {
            this.logger.error(
                `Broadcast failed for ${claim.inscriptionId}: ${String(error)}`,
            );
            await this.bridge.markFailed(claim.inscriptionId);
            return false;
        }

        // Step 4: Chain UTXOs for next attestation in this cycle
        this.pendingUtxos = receipt.newUTXOs;

        // Step 5: Mark as attested
        await this.bridge.markAttested(claim.inscriptionId, receipt.transactionId);

        this.logger.info(
            `Attested: ${claim.inscriptionId} -> token #${claim.tokenId} ` +
            `(tx: ${receipt.transactionId}, fee: ${receipt.estimatedFees} sats)`,
        );

        return true;
    }

    private static resolveNetwork(name: string): Network {
        switch (name) {
            case 'mainnet':
                return networks.bitcoin;
            case 'testnet':
                return networks.testnet;
            case 'regtest':
                return networks.regtest;
            default:
                throw new Error(`Unknown network: ${name}`);
        }
    }
}
