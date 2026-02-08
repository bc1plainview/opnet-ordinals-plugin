import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    ABIDataTypes,
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    EMPTY_POINTER,
    NetEvent,
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
    OP721,
    OP721InitParameters,
    Revert,
    SafeMath,
    StoredMapU256,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';

// ---------------------------------------------------------------
// Custom event: emitted when an Ordinals inscription is bridged
// ---------------------------------------------------------------
@final
class InscriptionBridgedEvent extends NetEvent {
    constructor(
        recipient: Address,
        inscriptionHash: u256,
        tokenId: u256,
    ) {
        const data = new BytesWriter(
            ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH + U256_BYTE_LENGTH,
        );
        data.writeAddress(recipient);
        data.writeU256(inscriptionHash);
        data.writeU256(tokenId);

        super('InscriptionBridged', data);
    }
}

// ---------------------------------------------------------------
// Storage pointers — allocated BEFORE class definition
// ---------------------------------------------------------------
const claimedMapPointer: u16 = Blockchain.nextPointer;
const attestCounterPointer: u16 = Blockchain.nextPointer;

/**
 * OrdinalsBridgeNFT — OP721 contract for bridging Ordinals inscriptions.
 *
 * The deployer acts as the bridge oracle. When an ordinal inscription is
 * burned (sent to the Satoshi genesis address), the oracle calls
 * `attestBurn(recipient, inscriptionHash, tokenId)` to mint the
 * corresponding OP721 NFT to the burner.
 *
 * Each inscription can only be bridged once (tracked via inscriptionHash).
 * Token IDs are assigned by the oracle to match the collection index.
 */
@final
export class OrdinalsBridgeNFT extends OP721 {
    // Maps inscription hash (u256) -> u256(1) if claimed
    private _claimed!: StoredMapU256;
    // Counter of total attestations processed
    private _attestCounter!: StoredU256;

    public constructor() {
        super();

        // Initialize storage in constructor body (NOT field initializers)
        this._claimed = new StoredMapU256(claimedMapPointer);
        this._attestCounter = new StoredU256(attestCounterPointer, EMPTY_POINTER);
    }

    /**
     * Called once on contract deployment.
     *
     * Calldata layout:
     *   - string: collection name
     *   - string: collection symbol
     *   - string: base metadata URI
     *   - u256:   max supply
     */
    public override onDeployment(calldata: Calldata): void {
        const name = calldata.readStringWithLength();
        const symbol = calldata.readStringWithLength();
        const baseURI = calldata.readStringWithLength();
        const maxSupply = calldata.readU256();

        this.instantiate(
            new OP721InitParameters(name, symbol, baseURI, maxSupply),
        );

        this._attestCounter.value = u256.Zero;
    }

    /**
     * Oracle-only: attest that an inscription was burned and mint
     * the corresponding OP721 to the recipient.
     *
     * @param to               - Recipient address (the burner)
     * @param inscriptionHash  - Keccak256 hash of the inscription ID string
     * @param tokenId          - Token ID matching the collection index
     */
    @method(
        { name: 'to', type: ABIDataTypes.ADDRESS },
        { name: 'inscriptionHash', type: ABIDataTypes.UINT256 },
        { name: 'tokenId', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('InscriptionBridged')
    public attestBurn(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const to = calldata.readAddress();
        const inscriptionHash = calldata.readU256();
        const tokenId = calldata.readU256();

        // Ensure this inscription hasn't been bridged before
        if (!this._claimed.get(inscriptionHash).isZero()) {
            throw new Revert('Inscription already bridged');
        }

        // Ensure the token ID hasn't been minted yet
        if (this._exists(tokenId)) {
            throw new Revert('Token ID already minted');
        }

        // Enforce max supply
        const currentSupply = this._totalSupply.value;
        if (SafeMath.gte(currentSupply, this._maxSupply.value)) {
            throw new Revert('Max supply reached');
        }

        // Mint the OP721 to the recipient
        this._mint(to, tokenId);

        // Mark inscription as claimed
        this._claimed.set(inscriptionHash, u256.One);

        // Increment attestation counter
        this._attestCounter.value = SafeMath.add(
            this._attestCounter.value,
            u256.One,
        );

        // Emit bridge-specific event
        this.emitEvent(new InscriptionBridgedEvent(to, inscriptionHash, tokenId));

        // Return success
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * View: check if an inscription hash has been bridged.
     */
    @method({ name: 'inscriptionHash', type: ABIDataTypes.UINT256 })
    @returns({ name: 'claimed', type: ABIDataTypes.BOOL })
    public isInscriptionClaimed(calldata: Calldata): BytesWriter {
        const inscriptionHash = calldata.readU256();
        const claimed = !this._claimed.get(inscriptionHash).isZero();

        const writer = new BytesWriter(1);
        writer.writeBoolean(claimed);
        return writer;
    }

    /**
     * View: get the total number of attestations processed.
     */
    @method()
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public attestCount(_calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeU256(this._attestCounter.value);
        return writer;
    }
}
