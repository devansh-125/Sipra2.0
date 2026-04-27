export const globalOtpStore = globalThis as unknown as {
    __otpMap: Map<string, { otp: string, expiresAt: number }>
};

if (!globalOtpStore.__otpMap) {
    globalOtpStore.__otpMap = new Map();
}

export const storeOtp = (email: string, otp: string) => {
    globalOtpStore.__otpMap.set(email.toLowerCase(), {
        otp,
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 mins
    });
};

export const verifyOtp = (email: string, otp: string): boolean => {
    const key = email.toLowerCase();
    const data = globalOtpStore.__otpMap.get(key);
    if (!data) return false;

    if (data.expiresAt < Date.now()) {
        globalOtpStore.__otpMap.delete(key);
        return false;
    }

    if (data.otp === otp) {
        globalOtpStore.__otpMap.delete(key);
        return true;
    }
    return false;
};
