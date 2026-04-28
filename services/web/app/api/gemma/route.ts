import { NextRequest, NextResponse } from 'next/server';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GemmaDriverInput {
    driverId: string;
    rewardRupees: number;
    alertOffsetMin: number; // minutes between mission alert and driver's red alert
    redZoneDurationMin: number; // minutes spent in red zone
}

export interface GemmaTripInput {
    trip_id: string;
    hospital_name: string;
    total_distance_km: number;
    golden_time_threshold_min: number;
    elapsed_min: number;
    progress_percent: number;
    drone_activated: boolean;
    drivers: GemmaDriverInput[];
    // Financial summaries (deterministic, code-calculated)
    rewards_subtotal: number;
    distance_fee: number;
    platform_charge: number;
    compliance_fee: number;
    total_payable: number;
}

export interface GemmaDriverSummary {
    driverId: string;
    label: string; // e.g. "Fast responder", "Critical support contributor"
    explanation: string; // 1–2 sentences
}

export interface GemmaReport {
    mission_title: string;
    hospital_summary: string;
    driver_summaries: GemmaDriverSummary[];
    risk_status: 'Safe' | 'Watchlist' | 'Critical' | 'Drone Required';
    drone_reason: string;
    what_if_note: string;
    final_note: string;
}

// ── POST /api/gemma ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GEMINI_AI_KEY;

    if (!apiKey) {
        // Return a mock report so the UI still works without a key
        return NextResponse.json(buildMockReport(), { status: 200 });
    }

    let body: GemmaTripInput;
    try {
        body = (await req.json()) as GemmaTripInput;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const prompt = buildPrompt(body);

    try {
        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 1024,
                        responseMimeType: 'application/json',
                    },
                }),
            },
        );

        if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            console.error('[/api/gemma] Gemini API error:', errText);
            // Fall back to mock on API error so demo never breaks
            return NextResponse.json(buildMockReport(body), { status: 200 });
        }

        const geminiJson = (await geminiRes.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
        };

        const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        // Parse JSON from model response (strip markdown fences if present)
        const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        let report: GemmaReport;
        try {
            report = JSON.parse(cleaned) as GemmaReport;
        } catch {
            console.warn('[/api/gemma] Failed to parse model JSON, using mock');
            report = buildMockReport(body);
        }

        return NextResponse.json(report, { status: 200 });
    } catch (err) {
        console.error('[/api/gemma] fetch error:', err);
        return NextResponse.json(buildMockReport(body), { status: 200 });
    }
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPrompt(data: GemmaTripInput): string {
    const driversJson = JSON.stringify(
        data.drivers.map((d) => ({
            driver_id: d.driverId,
            reward_inr: d.rewardRupees,
            alert_offset_min: d.alertOffsetMin,
            red_zone_duration_min: d.redZoneDurationMin,
        })),
        null,
        2,
    );

    return `You are SIPRA AI — an intelligent organ-logistics command system. Your job is to narrate organ delivery missions for hospitals and drivers.

Trip data (do NOT change any money values — they are pre-calculated by code):
{
  "trip_id": "${data.trip_id}",
  "hospital_name": "${data.hospital_name}",
  "total_distance_km": ${data.total_distance_km},
  "golden_time_threshold_min": ${data.golden_time_threshold_min},
  "elapsed_min": ${data.elapsed_min},
  "progress_percent": ${data.progress_percent},
  "drone_activated": ${data.drone_activated},
  "total_payable_inr": ${data.total_payable},
  "rewards_subtotal_inr": ${data.rewards_subtotal},
  "distance_fee_inr": ${data.distance_fee},
  "platform_charge_inr": ${data.platform_charge},
  "compliance_fee_inr": ${data.compliance_fee},
  "drivers": ${driversJson}
}

Return a JSON object ONLY (no markdown, no explanation outside JSON) with this exact shape:
{
  "mission_title": "<one dramatic mission title, max 8 words>",
  "hospital_summary": "<3–4 sentence executive briefing for the hospital, written like an AI command center report. Mention organ type (kidney), response times, golden time status, drone if activated, total drivers rewarded, and total payable amount exactly as given.>",
  "driver_summaries": [
    {
      "driverId": "<exact driver ID from input>",
      "label": "<one of: Fast responder | Critical support contributor | Delayed but valuable | High-priority emergency response | Efficient corridor clearance>",
      "explanation": "<1–2 sentences explaining this driver's performance based on alert_offset_min and red_zone_duration_min>"
    }
  ],
  "risk_status": "<one of: Safe | Watchlist | Critical | Drone Required>",
  "drone_reason": "<if drone_activated is true: 2–3 sentence dramatic explanation of why the drone was activated and how it preserved organ viability. If false: empty string>",
  "what_if_note": "<1–2 sentence predictive what-if insight, e.g. what would have happened without drone, or if drivers responded 2 min later>",
  "final_note": "<one sentence executive conclusion for the mission>"
}

driver_summaries must contain exactly ${data.drivers.length} entries, one per driver in the same order as input.
risk_status must be "Drone Required" if drone_activated is true, "Critical" if progress_percent > 80, "Watchlist" if progress_percent > 50, otherwise "Safe".
`;
}

// ── Fallback mock report ───────────────────────────────────────────────────────

function buildMockReport(data?: Partial<GemmaTripInput>): GemmaReport {
    const droneActivated = data?.drone_activated ?? false;
    const progress = data?.progress_percent ?? 75;

    let risk_status: GemmaReport['risk_status'] = 'Safe';
    if (droneActivated) risk_status = 'Drone Required';
    else if (progress > 80) risk_status = 'Critical';
    else if (progress > 50) risk_status = 'Watchlist';

    const driverSummaries: GemmaDriverSummary[] = (data?.drivers ?? []).map((d) => {
        let label: string;
        let explanation: string;
        if (d.alertOffsetMin <= 10) {
            label = 'Fast responder';
            explanation = `Driver ${d.driverId} responded within the critical ${d.alertOffsetMin}-minute window, helping preserve corridor integrity early in the mission.`;
        } else if (d.alertOffsetMin <= 20) {
            label = 'Critical support contributor';
            explanation = `Driver ${d.driverId} cleared the red zone in ${d.redZoneDurationMin} minutes, providing meaningful support during the active alert phase.`;
        } else {
            label = 'Delayed but valuable';
            explanation = `Driver ${d.driverId} responded after a ${d.alertOffsetMin}-minute delay but still cleared the zone, contributing to overall corridor safety.`;
        }
        return { driverId: d.driverId, label, explanation };
    });

    return {
        mission_title: droneActivated
            ? 'Drone Fallback — Golden Time Preserved'
            : 'Emergency Organ Transit — Corridor Cleared',
        hospital_summary: `SIPRA AI Command confirms organ transit mission for ${data?.hospital_name ?? 'Tender Palm Hospital'}. A live donor kidney was dispatched following red-zone corridor activation, with ${data?.drivers?.length ?? 15} drivers rewarded for emergency compliance. ${droneActivated ? 'Drone fallback was activated at the route midpoint to ensure golden-time delivery.' : 'Road delivery remained viable throughout the mission.'} Total payable generated: ₹${data?.total_payable ?? 0}.`,
        driver_summaries: driverSummaries,
        risk_status,
        drone_reason: droneActivated
            ? 'Road transport risk exceeded acceptable thresholds at the mission midpoint. Traffic conditions and golden-time pressure triggered automatic drone handoff. The drone ensured organ viability was preserved for the remainder of the journey to the destination hospital.'
            : '',
        what_if_note: droneActivated
            ? 'Without drone activation, estimated organ viability would have been compromised by approximately 18 minutes, likely missing the golden-time threshold.'
            : `Had drivers responded 2 minutes later on average, the red-zone clearance would have extended by an estimated 12%, putting golden-time delivery at risk.`,
        final_note: `Mission executed successfully with AI-assisted logistics, demonstrating SIPRA's capability as a real-time medical command platform.`,
    };
}
