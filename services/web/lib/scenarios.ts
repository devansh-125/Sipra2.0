/**
 * Scenario catalog for the dashboard's "Run Scenario" button.
 *
 * Each entry is a real dataset under datasets/test-scenarios/realtime/<key>/.
 * Only the ambulance ping stream is synthetic — corridor, AI, drone, bounty,
 * and dashboard are all driven by the live backend.
 */
export type ScenarioKey = 's1-normal' | 's2-congestion' | 's3-drone-handoff';

export interface ScenarioMeta {
  key: ScenarioKey;
  title: string;
  tagline: string;
  outcome: string;
  goldenHourMin: number;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    key: 's1-normal',
    title: 'Normal Run',
    tagline: 'Clear NH-48 cruise from Manipal HAL → Sri Siddhartha, Tumkur',
    outcome: 'Ambulance arrives in ~73 min with a 12-min margin. AI green (8.5% breach risk).',
    goldenHourMin: 90,
  },
  {
    key: 's2-congestion',
    title: 'Peak-Hour Congestion',
    tagline: 'Blood platelets hit gridlock on NH-48 — bounty surge clears the corridor',
    outcome: 'AI triggers BOUNTY_BOOST mid-congestion. Traffic clears, ambulance finishes within 150-min window.',
    goldenHourMin: 150,
  },
  {
    key: 's3-drone-handoff',
    title: 'Drone Handoff',
    tagline: 'Lorry blocks NH-48; rain prevents clearance — AI fires HANDOFF_INITIATED',
    outcome: 'Breach probability = 1.0. Drone SIPRA-DRONE-A41Z dispatched, 45-min delivery.',
    goldenHourMin: 90,
  },
];

export const HOSPITAL_PAIR = {
  origin: 'Manipal Hospital HAL, Bangalore',
  destination: 'Sri Siddhartha Medical College, Tumkur',
  distanceKm: 100,
  route: 'NH-48',
};
