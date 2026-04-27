import { useEffect, useState } from 'react';

export type LedgerBlock = {
    blockNumber: number;
    timestamp: string;
    missionId: string;
    eventType: string;
    actor: string;
    payload: Record<string, any>;
    previousHash: string;
    currentHash: string;
    verifyingStatus: 'Pending' | 'Verifying' | 'Verified' | 'Failed';
};

type LedgerState = {
    blocks: LedgerBlock[];
    integrityStatus: 'Verified' | 'Tampering Detected' | 'Under Review';
};

// Singleton store for demo purposes
let ledger: LedgerBlock[] = [];
let eventQueue: any[] = [];
let isProcessingQueue = false;
let listeners: Set<() => void> = new Set();
let integrityStatus: LedgerState['integrityStatus'] = 'Verified';

// Simple fast sync hash to simulate blockchain block hash
function generateSyncHash(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        const char = data.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to hex and pad to look like a real hash
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    // Just append some pseudo-random but deterministic hex for visual weight
    const payloadLenHex = data.length.toString(16).padStart(4, '0');
    let secondaryHash = 0;
    for (let i = data.length - 1; i >= 0; i--) {
        secondaryHash = (secondaryHash << 5) - secondaryHash + data.charCodeAt(i);
        secondaryHash = secondaryHash & secondaryHash;
    }
    const hex2 = Math.abs(secondaryHash).toString(16).padStart(8, '0');
    return `0x${hex}${payloadLenHex}${hex2}a9f82${hex}`;
}

const GENESIS_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

const updateGlobalStatus = () => {
    let isIntact = true;
    for (let i = 0; i < ledger.length; i++) {
        if (ledger[i].verifyingStatus === 'Failed') {
            isIntact = false;
        }
    }

    // Calculate if we're completely done verifying the queue
    const allVerified = ledger.length > 0 && ledger.every(b => b.verifyingStatus === 'Verified') && eventQueue.length === 0;

    if (!isIntact) {
        integrityStatus = 'Tampering Detected';
    } else if (!allVerified) {
        integrityStatus = 'Under Review';
    } else {
        integrityStatus = 'Verified';
    }

    listeners.forEach(l => l());
};

const processQueue = () => {
    if (isProcessingQueue || eventQueue.length === 0) return;
    isProcessingQueue = true;

    const event = eventQueue.shift();
    const { missionId, eventType, actor, payload } = event;

    const blockNumber = ledger.length;
    const timestamp = new Date().toISOString();
    const previousHash = blockNumber === 0 ? GENESIS_HASH : ledger[blockNumber - 1].currentHash;

    const dataToHash = `${blockNumber}${timestamp}${missionId}${eventType}${actor}${JSON.stringify(payload)}${previousHash}`;
    const currentHash = generateSyncHash(dataToHash);

    const block: LedgerBlock = {
        blockNumber,
        timestamp,
        missionId,
        eventType,
        actor,
        payload,
        previousHash,
        currentHash,
        verifyingStatus: 'Pending'
    };

    ledger.push(block);
    updateGlobalStatus();

    // 1. Wait a bit, then switch to Verifying
    setTimeout(() => {
        block.verifyingStatus = 'Verifying';
        updateGlobalStatus();

        // 2. Wait a bit, then make Verified (or Failed)
        setTimeout(() => {
            const currentDataToHash = `${block.blockNumber}${block.timestamp}${block.missionId}${block.eventType}${block.actor}${JSON.stringify(block.payload)}${block.previousHash}`;
            const currentComputedHash = generateSyncHash(currentDataToHash);

            if (currentComputedHash !== block.currentHash) {
                block.verifyingStatus = 'Failed';
            } else {
                block.verifyingStatus = 'Verified';
            }
            updateGlobalStatus();

            // Next item
            isProcessingQueue = false;
            if (eventQueue.length > 0) {
                setTimeout(processQueue, 300); // Small rest between blocks
            }
        }, 1200);

    }, 800);
}

export const TrustLedger = {
    getBlocks: () => ledger,
    getStatus: () => integrityStatus,

    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },

    notify() {
        listeners.forEach(l => l());
    },

    addEvent(missionId: string, eventType: string, actor: string, payload: Record<string, any> = {}) {
        // Avoid duplicate events in quick succession (check queue and ledger)
        if (ledger.length > 0 || eventQueue.length > 0) {
            const last = eventQueue.length > 0 ? eventQueue[eventQueue.length - 1] : ledger[ledger.length - 1];
            if (last.eventType === eventType && last.actor === actor) {
                return; // debounce duplicate
            }
        }

        eventQueue.push({ missionId, eventType, actor, payload });
        processQueue();
    },

    verifyChain() {
        integrityStatus = 'Under Review';
        this.notify();

        // Put all blocks back to Verifying to simulate full chain audit
        ledger.forEach(b => {
            if (b.verifyingStatus === 'Verified') {
                b.verifyingStatus = 'Verifying';
            }
        });
        this.notify();

        setTimeout(() => {
            let isIntact = true;
            for (let i = 0; i < ledger.length; i++) {
                const block = ledger[i];
                const prevHash = i === 0 ? GENESIS_HASH : ledger[i - 1].currentHash;

                const dataToHash = `${block.blockNumber}${block.timestamp}${block.missionId}${block.eventType}${block.actor}${JSON.stringify(block.payload)}${prevHash}`;
                const computedHash = generateSyncHash(dataToHash);

                if (computedHash !== block.currentHash || prevHash !== block.previousHash) {
                    block.verifyingStatus = 'Failed';
                    isIntact = false;
                } else {
                    block.verifyingStatus = 'Verified';
                }
            }
            integrityStatus = isIntact ? 'Verified' : 'Tampering Detected';
            this.notify();
        }, 1500);
    },

    // For demo: modify a block to show tampering
    tamperBlock(index: number, fakeData: any = { amount: '$9,999,999.00' }) {
        if (ledger[index]) {
            ledger[index].payload = { ...ledger[index].payload, ...fakeData };
            this.notify();
        }
    },

    clear() {
        ledger = [];
        eventQueue = [];
        isProcessingQueue = false;
        integrityStatus = 'Verified';
        this.notify();
    }
};

export function useTrustLedger() {
    const [blocks, setBlocks] = useState(TrustLedger.getBlocks());
    const [status, setStatus] = useState(TrustLedger.getStatus());

    useEffect(() => {
        return TrustLedger.subscribe(() => {
            setBlocks([...TrustLedger.getBlocks()]);
            setStatus(TrustLedger.getStatus());
        });
    }, []);

    return {
        blocks,
        status,
        verifyChain: () => TrustLedger.verifyChain(),
        tamperBlock: (index: number) => TrustLedger.tamperBlock(index)
    };
}
