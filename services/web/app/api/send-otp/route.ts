import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { storeOtp } from '../../../lib/otpStore';

export async function POST(req: Request) {
    try {
        const { email } = await req.json();
        const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

        if (!normalizedEmail) {
            return NextResponse.json({ error: 'Email is required' }, { status: 400 });
        }

        // Generate a 4-digit OTP
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        storeOtp(normalizedEmail, otp);

        console.log("OTP:", otp);
        console.log("Sending to:", normalizedEmail);

        // Required credentials
        const user = process.env.EMAIL_USER || process.env.SMTP_USER || '';
        const rawPass = process.env.EMAIL_PASS || process.env.SMTP_PASS || '';
        const pass = rawPass.replace(/\s+/g, '');

        if (!user || !pass) {
            console.warn('[Demo] Missing SMTP credentials — returning OTP in response for demo mode.');
            return NextResponse.json({
                success: true,
                message: 'OTP generated (demo mode — no email sent).',
                devOtp: otp,
            });
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user,
                pass,
            },
        });

        // Ensure errors from sendMail are thrown and caught in the try/catch block
        await transporter.sendMail({
            from: `"SIPRA Hospital Verification" <${user}>`,
            to: normalizedEmail,
            subject: 'Hospital Login Verification - SIPRA Mission Control',
            text: `Your SIPRA identity verification OTP is: ${otp}\n\nThis code will expire in 5 minutes.`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; background: #0c0c1a; color: white;">
                    <h2 style="color: #60a5fa;">SIPRA Mission Control</h2>
                    <p>Hospital Identity Authentication Request.</p>
                    <div style="font-size: 24px; letter-spacing: 6px; font-weight: bold; padding: 12px; background: #1e1e2d; border-radius: 8px; text-align: center; color: white;">
                        ${otp}
                    </div>
                    <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This code expires in 5 minutes.</p>
                </div>
            `,
        });

        console.log('[Demo Backend] Email successfully delivered to', normalizedEmail);

        return NextResponse.json({ success: true, message: 'OTP sent successfully.' });
    } catch (error) {
        console.error('OTP Send Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
