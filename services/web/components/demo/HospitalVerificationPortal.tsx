'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, FileCheck, BrainCircuit, MailCheck, ShieldAlert, Fingerprint, Loader2, ArrowRight, UploadCloud, XCircle } from 'lucide-react';
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

    const [otpSent, setOtpSent] = useState(false);
    const [otpCode, setOtpCode] = useState('');
    const [devOtpHint, setDevOtpHint] = useState('');

    // File Upload State
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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

    const handleSendOTP = async () => {
        setIsProcessing(true);
        setErrorMsg('');
        try {
            const res = await fetch('/api/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: form.email })
            });
            const data = await res.json();

            if (res.ok) {
                setOtpSent(true);
                setStatus('UNVERIFIED');
                if (data.devOtp) {
                    setDevOtpHint(String(data.devOtp));
                    setOtpCode(String(data.devOtp));
                } else {
                    setDevOtpHint('');
                }
                TrustLedger.addEvent('DEMO-MISSION', 'OTP Requested', form.name, { email: form.email, result: 'Pending' });
            } else {
                setErrorMsg(data.error || 'Failed to send OTP.');
            }
        } catch (err) {
            setErrorMsg('Network error sending OTP');
        } finally {
            setIsProcessing(false);
        }
    };

    const handleVerifyOTP = async () => {
        if (!otpCode || otpCode.length < 4) return;
        setIsProcessing(true);
        setErrorMsg('');
        try {
            const res = await fetch('/api/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: form.email, otp: otpCode })
            });

            if (res.ok) {
                setStatus('OTP VERIFIED');
                setStep(3); // Unlocks Doc Upload
                TrustLedger.addEvent('DEMO-MISSION', 'OTP Verification', 'System Auth', { method: 'Email OTP', result: 'Success', hospital: form.name });
            } else {
                const data = await res.json();
                setErrorMsg(data.error || 'Invalid OTP');
            }
        } catch (err) {
            setErrorMsg('Network error verifying OTP');
        } finally {
            setIsProcessing(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const file = e.target.files[0];
            setSelectedFile(file);
            setPreviewUrl(URL.createObjectURL(file));
        }
    };

    const handleUploadAndAnalyze = async () => {
        if (!selectedFile) {
            setErrorMsg('Please upload a document first.');
            return;
        }

        setIsProcessing(true);
        setErrorMsg('');

        // Simulate AI Scanning visual flow
        setScanPhase('scanning_text');
        await new Promise(r => setTimeout(r, 1200));
        setScanPhase('checking_signatures');
        await new Promise(r => setTimeout(r, 1200));
        setScanPhase('verifying_db');
        await new Promise(r => setTimeout(r, 1000));
        setScanPhase('idle');

        // Calculate Trust Score based on license
        let calculatedScore = 50;
        let finalStatus: UIStatus = 'PENDING REVIEW';

        if (form.license.startsWith('GOV-')) {
            calculatedScore = 92;
            finalStatus = 'VERIFIED';
        } else if (form.license.startsWith('PVT-')) {
            calculatedScore = 78;
            finalStatus = 'PENDING REVIEW';
        } else {
            calculatedScore = 32;
            finalStatus = 'REJECTED';
        }

        setTrustScore(calculatedScore);
        setStatus(finalStatus);
        setIsProcessing(false);
        setStep(4); // Locks previous steps, shows Results
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

    const INPUT_STYLE = "w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40 outline-none disabled:opacity-50 disabled:cursor-not-allowed";

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col p-6 items-center selection:bg-blue-500/30">
            <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">

                {/* Left Column: Flow Context */}
                <div className="md:col-span-1 space-y-4">
                    <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800 shadow-xl">
                        <h1 className="text-xl font-bold tracking-tight text-white mb-1">Hospital Verification</h1>
                        <p className="text-xs text-slate-400 mb-6 uppercase tracking-wider">Secure access for verified medical institutions only</p>

                        <div className="space-y-4 text-sm text-slate-300">
                            <div className={`flex items-start gap-3 transition-opacity ${step >= 1 ? 'opacity-100' : 'opacity-40'}`}>
                                <ShieldCheck className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                                <p>1. Institutional Registration & Identity</p>
                            </div>
                            <div className={`flex items-start gap-3 transition-opacity ${step >= 3 ? 'opacity-100' : 'opacity-40'}`}>
                                <FileCheck className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                                <p>2. Medical License Verification Scan</p>
                            </div>
                            <div className={`flex items-start gap-3 transition-opacity ${step === 4 ? 'opacity-100' : 'opacity-40'}`}>
                                <BrainCircuit className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                                <p>3. AI Authenticity Scoring</p>
                            </div>
                        </div>
                    </div>

                    <div className={`p-5 rounded-xl border flex flex-col items-center justify-center transition-colors shadow-lg ${getStatusColor()}`}>
                        <h3 className="text-xs uppercase tracking-widest opacity-80 mb-1">Status</h3>
                        <p className="text-lg font-bold tracking-wide">{status}</p>
                        {trustScore > 0 && (
                            <p className="text-2xl font-mono mt-2">{trustScore}% Trust</p>
                        )}
                    </div>

                    {errorMsg && (
                        <div className="p-4 bg-red-900/20 border border-red-500/50 rounded flex items-center gap-2 text-red-400 text-sm animate-in fade-in zoom-in-95">
                            <XCircle className="w-4 h-4 shrink-0" />
                            {errorMsg}
                        </div>
                    )}
                </div>

                {/* Right Column: Dynamic Steps */}
                <div className="md:col-span-2 space-y-6">

                    {/* Step 1 & 2: Form & OTP */}
                    {step <= 3 && (
                        <div className={`p-6 rounded-xl bg-slate-900 border border-slate-800 shadow-xl transition-all ${step > 2 ? 'opacity-60 pointer-events-none' : ''}`}>
                            <h2 className="text-lg font-semibold text-white mb-4">1. Entity Registration</h2>

                            <div className="grid grid-cols-2 gap-4 mb-6">
                                <div>
                                    <label className="text-xs uppercase text-slate-500 mb-1 block">Hospital Name *</label>
                                    <input type="text" className={INPUT_STYLE} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={otpSent} />
                                </div>
                                <div>
                                    <label className="text-xs uppercase text-slate-500 mb-1 block">Registration/License ID *</label>
                                    <input type="text" className={INPUT_STYLE} value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} placeholder="GOV-..." disabled={otpSent} />
                                    <p className="text-[10px] text-slate-500 mt-1">Hint: GOV- yields high trust, PVT- yields review</p>
                                </div>
                                <div>
                                    <label className="text-xs uppercase text-slate-500 mb-1 block">Official Email *</label>
                                    <input type="email" className={INPUT_STYLE} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={otpSent} />
                                </div>
                                <div>
                                    <label className="text-xs uppercase text-slate-500 mb-1 block">Phone Number *</label>
                                    <input type="text" className={INPUT_STYLE} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={otpSent} />
                                </div>
                            </div>

                            {!otpSent ? (
                                <button
                                    onClick={handleSendOTP}
                                    disabled={isProcessing}
                                    className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-4 py-2 rounded shadow flex items-center justify-center transition-colors"
                                >
                                    {isProcessing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <MailCheck className="w-4 h-4 mr-2" />}
                                    Send Security OTP
                                </button>
                            ) : (
                                <div className="bg-blue-900/20 border border-blue-500/30 p-4 rounded-lg mt-4 animate-in fade-in slide-in-from-top-2">
                                    <p className="text-sm text-blue-300 mb-3 block">✓ OTP sent to official hospital email ({form.email})</p>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            className={`${INPUT_STYLE} font-mono tracking-widest w-40 text-center text-lg`}
                                            placeholder="1234"
                                            value={otpCode}
                                            onChange={(e) => setOtpCode(e.target.value)}
                                            maxLength={6}
                                            disabled={step > 2}
                                        />
                                        <button
                                            onClick={handleVerifyOTP}
                                            disabled={isProcessing || otpCode.length < 4 || step > 2}
                                            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium px-6 py-2 rounded shadow transition-colors"
                                        >
                                            {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify Code'}
                                        </button>
                                    </div>
                                    {devOtpHint && (
                                        <p className="text-xs text-amber-300 mt-2">
                                            Dev mode OTP: <span className="font-mono tracking-widest">{devOtpHint}</span>
                                        </p>
                                    )}
                                    <p className="text-[10px] text-slate-500 mt-3 pt-2 border-t border-blue-500/20">
                                        Check your email inbox or demo terminal for the OTP.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Step 3: Document Upload */}
                    {step === 3 && (
                        <div className="p-6 rounded-xl bg-slate-900 border border-slate-800 shadow-xl animate-in fade-in slide-in-from-right-4">
                            <div className="flex items-center gap-3 mb-4">
                                <FileCheck className="w-5 h-5 text-indigo-400" />
                                <h2 className="text-lg font-semibold text-white">2. Medical License Upload</h2>
                            </div>
                            <p className="text-sm text-slate-400 mb-6">Please upload a valid hospital license or government ID to verify authenticity.</p>

                            {!selectedFile ? (
                                <label className="cursor-pointer border-2 border-dashed border-slate-700 hover:border-indigo-500 hover:bg-indigo-500/5 rounded-lg p-10 flex flex-col items-center justify-center text-center transition-all">
                                    <input type="file" accept="image/*,application/pdf" className="hidden" onChange={handleFileChange} />
                                    <div className="bg-slate-800 p-4 rounded-full mb-4">
                                        <UploadCloud className="w-8 h-8 text-indigo-400" />
                                    </div>
                                    <p className="text-sm text-slate-300 font-medium tracking-wide">Click or drag document to upload</p>
                                    <p className="text-xs text-slate-500 mt-1">PDF, JPEG, or PNG up to 10MB</p>
                                </label>
                            ) : (
                                <div className="border border-slate-700 rounded-lg p-6 flex flex-col items-center text-center animate-in zoom-in-95">
                                    {previewUrl && (
                                        <div className="w-48 h-32 mb-4 border border-slate-600 rounded bg-black flex items-center justify-center overflow-hidden">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={previewUrl} alt="Document preview" className="object-cover w-full h-full opacity-80" />
                                        </div>
                                    )}
                                    <p className="text-sm font-medium text-white break-all mb-4">{selectedFile.name}</p>

                                    {scanPhase !== 'idle' ? (
                                        <div className="w-full max-w-sm mt-2">
                                            <div className="flex justify-between text-xs text-indigo-400 mb-1 uppercase tracking-widest font-semibold">
                                                <span>AI Scanning</span>
                                                <span className="animate-pulse">
                                                    {scanPhase === 'scanning_text' && 'Extracting text...'}
                                                    {scanPhase === 'checking_signatures' && 'Verifying signatures...'}
                                                    {scanPhase === 'verifying_db' && 'Cross-referencing DB...'}
                                                </span>
                                            </div>
                                            <div className="h-1 bg-slate-800 rounded overflow-hidden">
                                                <div className="h-full bg-indigo-500 rounded transition-all duration-300" style={{
                                                    width: scanPhase === 'scanning_text' ? '30%' : scanPhase === 'checking_signatures' ? '60%' : '90%'
                                                }}></div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex gap-4">
                                            <button onClick={() => setSelectedFile(null)} disabled={isProcessing} className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white transition">Remove</button>
                                            <button
                                                onClick={handleUploadAndAnalyze}
                                                disabled={isProcessing}
                                                className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-2 rounded shadow-lg shadow-indigo-500/20 flex items-center justify-center transition-colors"
                                            >
                                                <BrainCircuit className="w-4 h-4 mr-2" />
                                                Analyze Document
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Step 4: Final Results & AI Summary */}
                    {step === 4 && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-6">

                            {/* Gemma Analysis Card */}
                            <div className="p-6 rounded-xl border border-indigo-500/20 bg-gradient-to-br from-indigo-950/40 to-slate-900 shadow-xl relative overflow-hidden">
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
                            <div className="p-6 rounded-xl bg-slate-900 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between shadow-xl gap-4">
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
    );
}
