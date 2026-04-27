import { NextResponse } from 'next/server';
import { verifyOtp } from '../../../lib/otpStore';

export async function POST(req: Request) {
    try {
        const { email, otp } = await req.json();
        const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
        const normalizedOtp = typeof otp === 'string' ? otp.trim() : '';

        if (!normalizedEmail || !normalizedOtp) {
            return NextResponse.json({ error: 'Email and OTP are required' }, { status: 400 });
        }

        const isValid = verifyOtp(normalizedEmail, normalizedOtp);

        if (isValid) {
            return NextResponse.json({ success: true, message: 'OTP verified' });
        } else {
            return NextResponse.json({ error: 'Invalid or expired OTP' }, { status: 400 });
        }
    } catch (error) {
        console.error('Verify OTP Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
