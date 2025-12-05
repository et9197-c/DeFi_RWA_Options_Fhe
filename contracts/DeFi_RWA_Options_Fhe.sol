pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RWAOptionsFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidAddress();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error ProofVerificationFailed();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool active;
        uint256 createdAt;
        uint256 closedAt;
    }
    Batch public currentBatch;
    uint256 public nextBatchId = 1;

    struct EncryptedPosition {
        euint32 strikePrice; // Encrypted strike price
        euint32 underlyingPrice; // Encrypted underlying asset price
        euint32 quantity; // Encrypted quantity
        ebool isCall; // Encrypted option type (true for Call, false for Put)
    }
    mapping(uint256 => mapping(address => EncryptedPosition)) public positions;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PositionSubmitted(address indexed provider, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] results);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 30; // Default cooldown
        _openNewBatch();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidAddress();
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            delete isProvider[provider];
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); // Cannot unpause if not paused
        paused = false;
        emit ContractUnpaused();
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        _openNewBatch();
    }

    function closeCurrentBatch() external onlyOwner {
        if (!currentBatch.active) revert BatchClosed();
        currentBatch.active = false;
        currentBatch.closedAt = block.timestamp;
        emit BatchClosed(currentBatch.id);
    }

    function submitEncryptedPosition(
        euint32 strikePrice,
        euint32 underlyingPrice,
        euint32 quantity,
        ebool isCall
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!currentBatch.active) revert BatchClosed();

        _initIfNeeded(strikePrice);
        _initIfNeeded(underlyingPrice);
        _initIfNeeded(quantity);
        _initIfNeeded(isCall);

        positions[currentBatch.id][msg.sender] = EncryptedPosition({
            strikePrice: strikePrice,
            underlyingPrice: underlyingPrice,
            quantity: quantity,
            isCall: isCall
        });

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit PositionSubmitted(msg.sender, currentBatch.id);
    }

    function requestBatchSettlement(uint256 batchId) external onlyOwner {
        if (batchId != currentBatch.id) revert BatchNotClosed(); // Can only settle the current batch
        if (currentBatch.active) revert BatchNotClosed(); // Batch must be closed

        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // 1. Prepare Ciphertexts
        // For this example, we'll sum all quantities in the batch
        // In a real protocol, this would be more complex option payoff calculations
        euint32 memory totalQuantity = FHE.asEuint32(0);
        bool initialized = false;
        for (uint256 i = 0; i < 10; i++) { // Example: iterate over 10 possible providers
            address provider = address(uint160(i + 1)); // Example provider address generation
            if (positions[batchId][provider].quantity.isInitialized()) {
                if (!initialized) {
                    totalQuantity = positions[batchId][provider].quantity;
                    initialized = true;
                } else {
                    totalQuantity = totalQuantity.add(positions[batchId][provider].quantity);
                }
            }
        }
        if (!initialized) totalQuantity = FHE.asEuint32(0); // Ensure it's initialized if no positions

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = totalQuantity.toBytes32();

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        // a. Replay Guard
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        // b. State Verification
        // Rebuild cts array in the exact same order as in requestBatchSettlement
        euint32 memory totalQuantity = FHE.asEuint32(0);
        bool initialized = false;
        for (uint256 i = 0; i < 10; i++) { // Must match the logic in requestBatchSettlement
            address provider = address(uint160(i + 1));
            if (positions[decryptionContexts[requestId].batchId][provider].quantity.isInitialized()) {
                if (!initialized) {
                    totalQuantity = positions[decryptionContexts[requestId].batchId][provider].quantity;
                    initialized = true;
                } else {
                    totalQuantity = totalQuantity.add(positions[decryptionContexts[requestId].batchId][provider].quantity);
                }
            }
        }
        if (!initialized) totalQuantity = FHE.asEuint32(0);

        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = totalQuantity.toBytes32();
        bytes32 currentHash = _hashCiphertexts(currentCts);

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert ProofVerificationFailed();
        }

        // d. Decode & Finalize
        uint256 totalQuantityCleartext = abi.decode(cleartexts, (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, [totalQuantityCleartext]);
        // In a real protocol, this result would be used for settlement logic
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal {
        if (!x.isInitialized()) {
            x = FHE.asEuint32(0);
        }
    }

    function _initIfNeeded(ebool x) internal {
        if (!x.isInitialized()) {
            x = FHE.asEbool(false);
        }
    }

    function _openNewBatch() private {
        currentBatch = Batch({
            id: nextBatchId,
            active: true,
            createdAt: block.timestamp,
            closedAt: 0
        });
        nextBatchId++;
        emit BatchOpened(currentBatch.id);
    }
}