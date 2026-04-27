'use client';

import React, { useState } from 'react';
import { useTrustLedger, TrustLedger } from '../../lib/trustLedger';
import { CheckCircle2, Shield, ShieldAlert, ShieldCheck, Activity, Link as LinkIcon, Database, AlertTriangle, Fingerprint, Clock, Loader2 } from 'lucide-react';

export default function MissionTrustLedger() {
    const { blocks, status, verifyChain, tamperBlock } = useTrustLedger();
    const [showAdmin, setShowAdmin] = useState(false);

    const formatHash = (hash: string) => {
        if (!hash || hash.length < 14) return hash;
        return `${hash.slice(0, 6)}...${hash.slice(-6)}`;
    };

    const isVerified = status === 'Verified';
    const isReviewing = status === 'Under Review';
    const isTampered = status === 'Tampering Detected';

    const verifiedCount = blocks.filter(b => b.verifyingStatus === 'Verified').length;
    const isMissionComplete = blocks.some(b => b.eventType === 'Mission Completion' || b.eventType === 'Payment Generation');
    const isBlockchainReady = isMissionComplete && !isReviewing;

    return (
        <div className="flex flex-col h-full bg-[#0c0c1a] border-l border-[#1a1a3a] text-slate-300 font-sans">
            {/* Header */}
            <div className="p-4 border-b border-[#1a1a3a] bg-[#111122]">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <Shield className="w-5 h-5 text-indigo-400" />
                            <h2 className="font-bold text-lg text-white">Mission Trust Ledger</h2>
                        </div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5 ml-7">
                            Tamper-Proof Log
                        </div>
                    </div>
                    <button
                        onDoubleClick={() => setShowAdmin(!showAdmin)}
                        className="text-xs text-slate-500 hover:text-slate-300 cursor-default"
                    >
                        v1.0.3
                    </button>
                </div>

                <div className="flex items-center gap-2 mb-4">
                    <div className={`px-2 py-1 flex items-center gap-1 rounded text-xs font-medium uppercase tracking-wider ${isVerified ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                        isReviewing ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                            'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        }`}>
                        {isVerified && <ShieldCheck className="w-3 h-3" />}
                        {isReviewing && <Activity className="w-3 h-3 animate-pulse" />}
                        {isTampered && <ShieldAlert className="w-3 h-3" />}
                        {isVerified ? 'Chain Integrity OK' : isReviewing ? 'Under Review' : 'Tampering Detected'}
                    </div>
                    <div className="px-2 py-1 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded text-xs font-medium truncate max-w-[120px]">
                        {blocks.length} Blocks
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-[#1a1a3a] p-2 rounded">
                        <div className="text-slate-500 mb-1">Total Blocks Recorded</div>
                        <div className="text-white font-mono">{blocks.length}</div>
                    </div>
                    <div className="bg-[#1a1a3a] p-2 rounded">
                        <div className="text-slate-500 mb-1">Verified Transfers</div>
                        <div className="text-emerald-400 font-mono">{verifiedCount} / {blocks.length}</div>
                    </div>
                    <div className="col-span-2 bg-[#1a1a3a] p-2 rounded flex flex-col gap-1">
                        <div className="text-slate-500 flex justify-between">
                            <span>Last Verified Hash</span>
                            <Fingerprint className="w-3 h-3" />
                        </div>
                        <div className="text-indigo-300 font-mono text-[10px] truncate">
                            {blocks.length > 0 ? blocks[blocks.length - 1].currentHash : '0x0000000000000000'}
                        </div>
                    </div>
                </div>

                <div className="mt-4 relative group">
                    <button
                        onClick={verifyChain}
                        disabled={!isBlockchainReady}
                        className={`w-full py-2 text-white rounded text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${!isBlockchainReady ? 'bg-slate-700' : 'bg-indigo-600 hover:bg-indigo-500'}`}
                    >
                        {isReviewing ? 'Verifying...' : !isMissionComplete ? 'Awaiting Mission End' : 'Verify Ledger'}
                    </button>
                    {!isBlockchainReady && !isReviewing && (
                        <div className="absolute top-[-30px] left-1/2 transform -translate-x-1/2 w-48 text-center text-xs text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity bg-[#111122] p-1 rounded border border-slate-700 pointer-events-none">
                            Available after mission completion
                        </div>
                    )}
                </div>
            </div>

            {/* Admin Demo Tools (Hidden by default) */}
            {showAdmin && (
                <div className="p-3 bg-rose-500/10 border-b border-rose-500/20 text-xs">
                    <div className="flex items-center gap-1 text-rose-400 font-bold mb-2">
                        <AlertTriangle className="w-3 h-3" />
                        Admin / Demo Controls
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => {
                                if (blocks.length > 0) {
                                    tamperBlock(Math.floor(Math.random() * blocks.length));
                                }
                            }}
                            className="px-2 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded"
                        >
                            Tamper Random Block
                        </button>
                        <button
                            onClick={() => TrustLedger.clear()}
                            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded"
                        >
                            Clear Chain
                        </button>
                    </div>
                </div>
            )}

            {/* Record List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    Mission Custody Trail
                </h3>

                {blocks.length === 0 ? (
                    <div className="text-center text-slate-500 text-sm mt-10">
                        Waiting for mission initialization...
                    </div>
                ) : (
                    <div className="space-y-4 relative">
                        {/* The vertical timeline line */}
                        <div className="absolute left-4 top-4 bottom-4 w-px bg-[#303050] z-0"></div>

                        {blocks.map((block, idx) => (
                            <div key={`${block.blockNumber}-${idx}`} className="relative z-10 flex gap-3">
                                <div className="flex flex-col items-center mt-1">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${block.verifyingStatus === 'Verified' ? 'bg-[#111122] border-indigo-500 text-indigo-400' :
                                            block.verifyingStatus === 'Failed' ? 'bg-rose-950 border-rose-500 text-rose-400' :
                                                block.verifyingStatus === 'Verifying' ? 'bg-indigo-900/40 border-indigo-400 text-indigo-300 animate-pulse' :
                                                    'bg-amber-900/40 border-amber-500 text-amber-400'
                                        }`}>
                                        {block.verifyingStatus === 'Verified' ? <ShieldCheck className="w-4 h-4" /> :
                                            block.verifyingStatus === 'Failed' ? <ShieldAlert className="w-4 h-4" /> :
                                                block.verifyingStatus === 'Verifying' ? <Loader2 className="w-4 h-4 animate-spin" /> :
                                                    <Clock className="w-4 h-4" />}
                                    </div>
                                </div>

                                <div className={`flex-1 rounded-lg border p-3 transition-colors duration-500 ${block.verifyingStatus === 'Verified' ? 'bg-[#151525] border-[#2a2a40]' :
                                        block.verifyingStatus === 'Failed' ? 'bg-rose-950/20 border-rose-500/50' :
                                            block.verifyingStatus === 'Verifying' ? 'bg-indigo-900/20 border-indigo-500/50' :
                                                'bg-amber-900/20 border-amber-500/40'
                                    }`}>
                                    <div className="flex justify-between items-start mb-2">
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <div className="text-xs text-indigo-400 font-mono">
                                                    Block #{block.blockNumber.toString().padStart(4, '0')}
                                                </div>
                                                {block.verifyingStatus !== 'Verified' && block.verifyingStatus !== 'Failed' && (
                                                    <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider ${block.verifyingStatus === 'Verifying' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-amber-500/20 text-amber-400'}`}>
                                                        {block.verifyingStatus}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="font-semibold text-sm text-white">
                                                {block.eventType}
                                            </div>
                                        </div>
                                        <div className="text-[10px] text-slate-500 bg-[#0c0c1a] px-2 py-1 rounded">
                                            {new Date(block.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                        </div>
                                    </div>

                                    <div className="text-xs text-slate-400 mb-2">
                                        Actor: <span className="text-slate-300">{block.actor}</span>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2 text-[9px] font-mono mt-3 p-2 bg-[#0c0c1a] rounded opacity-80">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-slate-600 flex items-center gap-1">
                                                <LinkIcon className="w-2 h-2" /> Prev Hash
                                            </span>
                                            <span className="text-slate-500">{formatHash(block.previousHash)}</span>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-indigo-500 flex items-center gap-1">
                                                <Activity className="w-2 h-2" /> Curr Hash
                                            </span>
                                            <span className="text-indigo-400">{block.verifyingStatus === 'Pending' ? '...' : formatHash(block.currentHash)}</span>
                                        </div>
                                    </div>

                                    {block.verifyingStatus === 'Failed' && (
                                        <div className="mt-2 text-xs text-rose-400 bg-rose-500/10 p-2 rounded flex items-center gap-1 border border-rose-500/20">
                                            <AlertTriangle className="w-3 h-3" /> Integrity mismatch found in payload or hash
                                        </div>
                                    )}

                                    {block.verifyingStatus === 'Verified' && (
                                        <div className="mt-2 text-[10px] text-emerald-500 flex items-center justify-between font-medium pb-0">
                                            <span className="flex items-center gap-1 text-indigo-500"><CheckCircle2 className="w-3 h-3" /> Immutable Record</span>
                                            <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Verified Transfer</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
