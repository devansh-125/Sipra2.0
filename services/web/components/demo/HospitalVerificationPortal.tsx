'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, FileCheck, BrainCircuit, ShieldAlert, Fingerprint, Loader2, ArrowRight, XCircle } from 'lucide-react';
import { useHospitalVerification } from '@/hooks/useHospitalVerification';
import { TrustLedger } from '../../lib/trustLedger';

type UIStatus = 'UNVERIFIED' | 'OTP VERIFIED' | 'PENDING REVIEW' | 'VERIFIED' | 'REJECTED';

// Gemma Mock Response Texts
const GEMMA_SUMMARY = `The uploaded document appears to be a hospital license with structured formatting and a matching registration pattern. Text extraction aligns with official government layouts.`;
const GEMMA_COMMENTARY = `The document confidence is high and the hospital appears legitimate for demo verification purposes. Registration format and departmental signatures detected.`;

export function HospitalVerificationPortal() {
    const router = useRouter();
    const { saveHospital } = useHospitalVerification();

    const [step, setStep] = useState<number>(1);
    const [isProcessing, setIsProcessing] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string>('');

    // Form State
    const [form, setForm] = useState({
        name: 'City Central Hospital',
        license: 'GOV-893-XX',
        contact: 'Dr. Sarah Smith',
        email: 'kinshuk380@gmail.com', // As requested for the demo
        phone: '+91-9876543210',
        address: '123 Health Ave, Mumbai',
        department: 'Emergency & Critical Care',
        purpose: 'Priority Organ Transport',
    });

    // AI Scanner State
    const [scanPhase, setScanPhase] = useState<'idle' | 'scanning_text' | 'checking_signatures' | 'verifying_db'>('idle');

    // Verification Results
    const [trustScore, setTrustScore] = useState<number>(0);
    const [status, setStatus] = useState<UIStatus>('UNVERIFIED');

    // Colors based on status
    const getStatusColor = () => {
        switch (status) {
            case 'PENDING REVIEW': return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
            case 'VERIFIED': return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
            case 'REJECTED': return 'text-red-400 bg-red-400/10 border-red-400/20';
            case 'OTP VERIFIED': return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
            default: return 'text-slate-400 bg-slate-800/50 border-slate-700';
        }
    };

    const handleVerify = async () => {
        setIsProcessing(true);
        setErrorMsg('');

        setScanPhase('scanning_text');
        await new Promise(r => setTimeout(r, 1100));
        setScanPhase('checking_signatures');
        await new Promise(r => setTimeout(r, 1100));
        setScanPhase('verifying_db');
        await new Promise(r => setTimeout(r, 900));
        setScanPhase('idle');

        const calculatedScore = form.license.startsWith('GOV-') ? 92 : form.license.startsWith('PVT-') ? 78 : 32;
        const finalStatus: UIStatus = form.license.startsWith('GOV-') ? 'VERIFIED' : form.license.startsWith('PVT-') ? 'PENDING REVIEW' : 'REJECTED';

        setTrustScore(calculatedScore);
        setStatus(finalStatus);
        setIsProcessing(false);
        setStep(4);

        TrustLedger.addEvent('DEMO-MISSION', 'AI Verification', 'SIPRA Auth Engine', { hospital: form.name, score: calculatedScore, result: finalStatus });
    };

    const handleComplete = () => {
        saveHospital({
            name: form.name,
            id: form.license,
            status: status
        });
        TrustLedger.addEvent('DEMO-MISSION', 'Hospital Registration', form.name, { authStatus: status, license: form.license });
        if (status === 'VERIFIED') {
            TrustLedger.addEvent('DEMO-MISSION', 'Hospital Approval', 'Chief Medical Officer', { approvalType: 'Emergency Transit', hospital: form.name });
            TrustLedger.addEvent('DEMO-MISSION', 'Mission Creation', 'SIPRA Core', { transport: 'Hybrid Ambulance+Drone' });
        }
        router.push('/demo/corridor-sim');
    };

    const INPUT_STYLE = "w-full bg-slate-950/80 border border-slate-700/80 rounded-lg px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40 outline-none disabled:opacity-50 disabled:cursor-not-allowed";

    return (
        <div className="relative h-screen overflow-y-auto overflow-x-hidden bg-slate-950 text-slate-200 selection:bg-blue-500/30">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.16),_transparent_42%),radial-gradient(circle_at_85%_15%,_rgba(14,116,144,0.14),_transparent_35%)]" />
            <div className="relative mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">

                {/* Left Column: Flow Context */}
                    <div className="space-y-4 lg:col-span-4 xl:col-span-3 lg:sticky lg:top-6 lg:self-start">
                        <div className="p-6 rounded-2xl bg-slate-900/70 border border-slate-700/70 shadow-[0_20px_45px_-25px_rgba(15,23,42,0.95)] backdrop-blur-sm">
                            <h1 className="text-2xl font-bold tracking-tight text-white mb-2">Hospital Verification</h1>
                            <p className="text-[11px] text-slate-400 mb-6 uppercase tracking-[0.14em]">Secure access for verified medical institutions only</p>

                            <div className="space-y-4 text-[15px] leading-relaxed text-slate-300">
                                <div className={`flex items-start gap-3 transition-opacity ${step >= 1 ? 'opacity-100' : 'opacity-40'}`}>
                                    <ShieldCheck className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                                    <p>1. Institutional Registration & Identity</p>
                                </div>
                                <div className={`flex items-start gap-3 transition-opacity ${step >= 4 ? 'opacity-100' : 'opacity-40'}`}>
                                    <FileCheck className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                                    <p>2. AI Document Analysis</p>
                                </div>
                                <div className={`flex items-start gap-3 transition-opacity ${step === 4 ? 'opacity-100' : 'opacity-40'}`}>
                                    <BrainCircuit className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                                    <p>3. AI Authenticity Scoring</p>
                                </div>
                            </div>
                        </div>

                        <div className={`p-5 rounded-2xl border flex flex-col items-center justify-center transition-colors shadow-[0_20px_45px_-25px_rgba(15,23,42,0.95)] ${getStatusColor()}`}>
                            <h3 className="text-xs uppercase tracking-[0.14em] opacity-80 mb-1">Status</h3>
                            <p className="text-2xl font-bold tracking-wide">{status}</p>
                            {trustScore > 0 && (
                                <p className="text-xl font-mono mt-2">{trustScore}% Trust</p>
                            )}
                        </div>
                    </div>

                    {errorMsg && (
                        <div className="p-4 bg-red-900/20 border border-red-500/50 rounded-xl flex items-center gap-2 text-red-400 text-sm animate-in fade-in zoom-in-95 lg:col-span-8 xl:col-span-9">
                            <XCircle className="w-4 h-4 shrink-0" />
                            {errorMsg}
                        </div>
                    )}

                {/* Right Column: Dynamic Steps */}
                    <div className="space-y-6 lg:col-span-8 xl:col-span-9">

                    {/* Step 1: Form + Verify button */}
                    {step === 1 && (
                        <div className="p-6 md:p-7 rounded-2xl bg-slate-900/75 border border-slate-700/70 shadow-[0_30px_60px_-35px_rgba(15,23,42,0.95)]">
                            <h2 className="text-3xl font-bold text-white mb-5">1. Entity Registration</h2>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                                <div>
                                    <label className="text-xs uppercase text-slate-400 mb-1.5 block tracking-[0.12em]">Hospital Name *</label>
                                    <input type="text" className={INPUT_STYLE} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                                </div>
                                <div>
                                    <label className="text-xs uppercase text-slate-400 mb-1.5 block tracking-[0.12em]">Registration/License ID *</label>
                                    <input type="text" className={INPUT_STYLE} value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} placeholder="GOV-..." />
                                    <p className="text-[10px] text-slate-500 mt-1">Hint: GOV- yields high trust, PVT- yields review</p>
                                </div>
                                <div>
                                    <label className="text-xs uppercase text-slate-400 mb-1.5 block tracking-[0.12em]">Official Email *</label>
                                    <input type="email" className={INPUT_STYLE} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                                </div>
                                <div>
                                    <label className="text-xs uppercase text-slate-400 mb-1.5 block tracking-[0.12em]">Phone Number *</label>
                                    <input type="text" className={INPUT_STYLE} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                                </div>
                            </div>

                            {scanPhase !== 'idle' ? (
                                <div className="w-full max-w-sm mt-2">
                                    <div className="flex justify-between text-xs text-indigo-400 mb-1 uppercase tracking-widest font-semibold">
                                        <span>AI Scanning</span>
                                        <span className="animate-pulse">
                                            {scanPhase === 'scanning_text' && 'Extracting identity...'}
                                            {scanPhase === 'checking_signatures' && 'Verifying signatures...'}
                                            {scanPhase === 'verifying_db' && 'Cross-referencing DB...'}
                                        </span>
                                    </div>
                                    <div className="h-1 bg-slate-800 rounded overflow-hidden">
                                        <div className="h-full bg-indigo-500 rounded transition-all duration-300" style={{
                                            width: scanPhase === 'scanning_text' ? '30%' : scanPhase === 'checking_signatures' ? '65%' : '92%'
                                        }} />
                                    </div>
                                </div>
                            ) : (
                                <button
                                    onClick={handleVerify}
                                    disabled={isProcessing}
                                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium px-6 py-2.5 rounded-lg shadow flex items-center justify-center transition-colors"
                                >
                                    {isProcessing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <BrainCircuit className="w-4 h-4 mr-2" />}
                                    Begin AI Verification
                                </button>
                            )}
                        </div>
                    )}

                    {/* Step 4: Final Results & AI Summary */}
                    {step === 4 && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-6">

                            {/* Gemma Analysis Card */}
                            <div className="p-6 md:p-7 rounded-2xl border border-indigo-500/20 bg-gradient-to-br from-indigo-950/40 to-slate-900 shadow-[0_30px_60px_-35px_rgba(15,23,42,0.95)] relative overflow-hidden">
                                <div className="absolute top-0 left-0 w-1 h-full bg-indigo-500 opacity-50"></div>
                                <div className="flex items-center gap-2 mb-6">
                                    <BrainCircuit className="w-5 h-5 text-indigo-400" />
                                    <h2 className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">AI Document Analysis</h2>
                                    <span className="ml-auto text-xs px-2 py-1 bg-indigo-500/10 text-indigo-300 rounded border border-indigo-500/20">Powered by Gemma</span>
                                </div>

                                <div className="grid grid-cols-2 gap-4 mb-4">
                                    <div className="bg-slate-900/80 p-3 rounded border border-slate-800 flex items-start gap-3">
                                        <div className="mt-1">
                                            {status === 'VERIFIED' ? <ShieldCheck className="w-5 h-5 text-emerald-500" /> : <ShieldAlert className="w-5 h-5 text-amber-500" />}
                                        </div>
                                        <div>
                                            <p className="text-[10px] text-slate-500 uppercase">Pattern Match</p>
                                            <p className="text-sm font-medium text-slate-200 mt-0.5">
                                                {status === 'VERIFIED' ? 'Matched Regional Format' : 'Unknown Pattern Detected'}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="bg-slate-900/80 p-3 rounded border border-slate-800 flex items-start gap-3">
                                        <div className="mt-1 flex-shrink-0">
                                            <Fingerprint className={`w-5 h-5 ${status === 'VERIFIED' ? 'text-emerald-500' : 'text-amber-500'}`} />
                                        </div>
                                        <div>
                                            <p className="text-[10px] text-slate-500 uppercase">Authenticity Signal</p>
                                            <p className={`text-sm font-medium mt-0.5 ${status === 'VERIFIED' ? 'text-emerald-400' : 'text-amber-400'}`}>
                                                {status === 'VERIFIED' ? 'High Baseline Confidence' : 'Requires Human Review'}
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-3 bg-slate-950/50 p-4 rounded text-sm text-slate-300 border border-slate-800/80 font-serif leading-relaxed">
                                    <p>{status === 'VERIFIED' ? GEMMA_SUMMARY : 'The document format differs from standard regional licenses. Verification flagged for standard manual compliance checking.'}</p>
                                    <p>{status === 'VERIFIED' ? GEMMA_COMMENTARY : 'Due to unknown ID formats, trust score lowered. Temporary access permitted with heavy restrictions.'}</p>
                                </div>
                            </div>

                            {/* Action Card */}
                            <div className="p-6 md:p-7 rounded-2xl bg-slate-900/75 border border-slate-700/70 flex flex-col md:flex-row md:items-center justify-between shadow-[0_30px_60px_-35px_rgba(15,23,42,0.95)] gap-4">
                                <div>
                                    <h3 className="text-lg font-bold text-white mb-1">Verification Complete</h3>
                                    <p className="text-sm text-slate-400">Institutional identity registered for demo operations.</p>
                                </div>
                                <button
                                    onClick={handleComplete}
                                    className={`flex items-center justify-center gap-2 px-6 py-3 rounded font-bold shadow-lg transition-all ${status === 'VERIFIED' ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-500/20' :
                                        status === 'PENDING REVIEW' ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-500/20' :
                                            'bg-red-600 hover:bg-red-500 text-white shadow-red-500/20'
                                        }`}
                                >
                                    {status === 'VERIFIED' ? 'Access Mission Dashboard' : 'Continue with Limits'}
                                    <ArrowRight className="w-4 h-4 shrink-0" />
                                </button>
                            </div>

                        </div>
                    )}

                    </div>
                </div>
            </div>
        </div>
    );
}
