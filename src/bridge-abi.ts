import {
    ABIDataTypes,
    BitcoinAbiTypes,
    type BitcoinInterfaceAbi,
    type CallResult,
    type OPNetEvent,
    type BaseContractProperties,
    OP_721_ABI,
} from 'opnet';
import type { Address } from '@btc-vision/transaction';

// ============================================================
// ABI for OrdinalsBridgeNFT — extends standard OP721 with
// bridge-specific methods and events.
// ============================================================

/**
 * Custom functions and events added by OrdinalsBridgeNFT on top
 * of the standard OP721 ABI.
 */
const BRIDGE_EXTENSIONS: BitcoinInterfaceAbi = [
    // attestBurn — deployer-only: mint an OP721 after verifying inscription burn
    {
        name: 'attestBurn',
        type: BitcoinAbiTypes.Function,
        inputs: [
            { name: 'to', type: ABIDataTypes.ADDRESS },
            { name: 'inscriptionHash', type: ABIDataTypes.UINT256 },
            { name: 'tokenId', type: ABIDataTypes.UINT256 },
        ],
        outputs: [
            { name: 'success', type: ABIDataTypes.BOOL },
        ],
    },

    // isInscriptionClaimed — view: check if inscription was already bridged
    {
        name: 'isInscriptionClaimed',
        type: BitcoinAbiTypes.Function,
        constant: true,
        inputs: [
            { name: 'inscriptionHash', type: ABIDataTypes.UINT256 },
        ],
        outputs: [
            { name: 'claimed', type: ABIDataTypes.BOOL },
        ],
    },

    // attestCount — view: total attestations processed
    {
        name: 'attestCount',
        type: BitcoinAbiTypes.Function,
        constant: true,
        inputs: [],
        outputs: [
            { name: 'count', type: ABIDataTypes.UINT256 },
        ],
    },

    // InscriptionBridged event
    {
        name: 'InscriptionBridged',
        type: BitcoinAbiTypes.Event,
        values: [
            { name: 'to', type: ABIDataTypes.ADDRESS },
            { name: 'inscriptionHash', type: ABIDataTypes.UINT256 },
            { name: 'tokenId', type: ABIDataTypes.UINT256 },
        ],
    },
];

/**
 * Full ABI for the OrdinalsBridgeNFT contract.
 * Combines the standard OP721 ABI with bridge-specific extensions.
 */
export const ORDINALS_BRIDGE_NFT_ABI: BitcoinInterfaceAbi = [
    ...OP_721_ABI,
    ...BRIDGE_EXTENSIONS,
];

// ============================================================
// Event types
// ============================================================

export type InscriptionBridgedEvent = {
    to: Address;
    inscriptionHash: bigint;
    tokenId: bigint;
    [key: string]: Address | bigint;
};

// ============================================================
// Result types
// ============================================================

export type AttestBurnResult = CallResult<
    { success: boolean },
    [OPNetEvent<InscriptionBridgedEvent>]
>;

export type IsInscriptionClaimedResult = CallResult<
    { claimed: boolean },
    []
>;

export type AttestCountResult = CallResult<
    { count: bigint },
    []
>;

// ============================================================
// Contract interface
// ============================================================

/**
 * TypeScript interface for the OrdinalsBridgeNFT contract.
 * Extends the standard OP721 interface with bridge methods.
 */
export interface IOrdinalsBridgeNFTContract extends BaseContractProperties {
    // --- Standard OP721 methods (inherited) ---
    name(): Promise<CallResult<{ name: string }, []>>;
    symbol(): Promise<CallResult<{ symbol: string }, []>>;
    maxSupply(): Promise<CallResult<{ maxSupply: bigint }, []>>;
    totalSupply(): Promise<CallResult<{ totalSupply: bigint }, []>>;
    ownerOf(tokenId: bigint): Promise<CallResult<{ owner: Address }, []>>;
    balanceOf(owner: Address): Promise<CallResult<{ balance: bigint }, []>>;
    tokenOfOwnerByIndex(
        owner: Address,
        index: bigint,
    ): Promise<CallResult<{ tokenId: bigint }, []>>;

    // --- Bridge-specific methods ---
    attestBurn(
        to: Address,
        inscriptionHash: bigint,
        tokenId: bigint,
    ): Promise<AttestBurnResult>;

    isInscriptionClaimed(
        inscriptionHash: bigint,
    ): Promise<IsInscriptionClaimedResult>;

    attestCount(): Promise<AttestCountResult>;
}
