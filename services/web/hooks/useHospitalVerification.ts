import { useState, useEffect } from 'react';

export type VerificationStatus = 'UNVERIFIED' | 'OTP VERIFIED' | 'PENDING REVIEW' | 'VERIFIED' | 'REJECTED';

export interface VerifiedHospital {
    name: string;
    id: string; // Registration/License ID
    status: VerificationStatus;
}

export function useHospitalVerification() {
    const [hospital, setHospital] = useState<VerifiedHospital | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        const data = sessionStorage.getItem('sipra_hospital_verification');
        if (data) {
            try {
                setHospital(JSON.parse(data));
            } catch (e) {
                console.error('Failed to parse hospital verification state', e);
            }
        }
        setIsLoaded(true);
    }, []);

    const saveHospital = (h: VerifiedHospital) => {
        sessionStorage.setItem('sipra_hospital_verification', JSON.stringify(h));
        setHospital(h);
    };

    const clearHospital = () => {
        sessionStorage.removeItem('sipra_hospital_verification');
        setHospital(null);
    };

    return { hospital, isLoaded, saveHospital, clearHospital };
}
